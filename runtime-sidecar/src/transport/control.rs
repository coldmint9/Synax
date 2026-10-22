//! Multiplex private RPCs with bounded execution and response buffering.
use prost::Message;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch};
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::transport::protocol::{
    WireEnvelope, WireError, decode_wire, encode_wire, wire_envelope,
};
use crate::transport::socket::{MAX_FRAME_BYTES, TransportError, read_frame, write_frame};

const PER_CONNECTION: usize = 32;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

pub struct ControlBudget {
    requests: Arc<Semaphore>,
    response_bytes: Arc<Semaphore>,
    critical_requests: Arc<Semaphore>,
    critical_bytes: Arc<Semaphore>,
}
impl ControlBudget {
    pub fn new() -> Self {
        Self {
            requests: Arc::new(Semaphore::new(128)),
            response_bytes: Arc::new(Semaphore::new(8 * 1024 * 1024)),
            critical_requests: Arc::new(Semaphore::new(16)),
            critical_bytes: Arc::new(Semaphore::new(2 * 1024 * 1024)),
        }
    }
}
struct Reply {
    bytes: Vec<u8>,
    shutdown: bool,
    _local: OwnedSemaphorePermit,
    _global: Option<OwnedSemaphorePermit>,
    _bytes: OwnedSemaphorePermit,
}

pub async fn run<S, F, Fut>(
    stream: S,
    shutdown: watch::Sender<bool>,
    budget: Arc<ControlBudget>,
    execute: F,
) -> Result<(), TransportError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    F: Fn(WireEnvelope) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = (WireEnvelope, bool)> + Send + 'static,
{
    use tracing::Instrument;
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (responses, mut replies) = mpsc::channel::<Reply>(PER_CONNECTION);
    let writer_shutdown = shutdown.clone();
    let mut writer = tokio::spawn(
        async move {
            while let Some(reply) = replies.recv().await {
                timeout(WRITE_TIMEOUT, write_frame(&mut writer, &reply.bytes))
                    .await
                    .map_err(|_| TransportError::Protocol("control response timed out".into()))??;
                if reply.shutdown {
                    let _ = writer_shutdown.send(true);
                }
            }
            Ok::<(), TransportError>(())
        }
        .in_current_span(),
    );
    let local = Arc::new(Semaphore::new(PER_CONNECTION));
    let mut jobs = JoinSet::new();
    let execute = Arc::new(execute);
    let mut stop = shutdown.subscribe();
    let mut writer_result = None;
    let result = loop {
        while jobs.try_join_next().is_some() {}
        let permit = tokio::select! {
            _ = stop.changed() => break Ok(()),
            result = &mut writer => { writer_result = Some(result); break Ok(()); },
            permit = local.clone().acquire_owned() => permit.unwrap(),
        };
        // read_exact is not cancellation-safe: only terminal conditions cancel a frame read.
        let request = tokio::select! {
            _ = stop.changed() => break Ok(()),
            result = &mut writer => { writer_result = Some(result); break Ok(()); },
            frame = read_frame(&mut reader) => match frame {
                Ok(frame) => match decode_wire(&frame) {
                    Ok(request) => request,
                    Err(error) => break Err(TransportError::Protocol(error.to_string())),
                },
                Err(TransportError::Io(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => break Ok(()),
                Err(error) => break Err(error),
            },
        };
        let stopping = matches!(request.body, Some(wire_envelope::Body::Shutdown(_)));
        if stopping {
            // A shutdown ACK is queued only after earlier accepted requests finish.
            if timeout(DRAIN_TIMEOUT, async {
                while jobs.join_next().await.is_some() {}
            })
            .await
            .is_err()
            {
                break Err(TransportError::Protocol("control drain timed out".into()));
            }
        }
        let critical = match &request.body {
            Some(wire_envelope::Body::Health(_) | wire_envelope::Body::Snapshot(_)) => true,
            // Lease probes are small, frequent and already fail closed on
            // errors. Keep them out of the 16-slot critical lane so snapshots
            // and execution-open/close controls cannot make the first token
            // wait behind a burst of revalidation checks.
            Some(wire_envelope::Body::ControlCommand(command)) => matches!(
                command.operation.as_str(),
                "execution_open"
                    | "execution_close"
                    | "stop_begin"
                    | "stop_unconfirmed"
                    | "resume"
                    | "read"
            ),
            _ => false,
        };
        let global = if critical {
            &budget.critical_requests
        } else {
            &budget.requests
        }
        .clone()
        .try_acquire_owned()
        .ok();
        let response_budget = if critical {
            &budget.critical_bytes
        } else {
            &budget.response_bytes
        }
        .clone();
        let responses = responses.clone();
        let execute = execute.clone();
        jobs.spawn(async move {
            let (response, shutdown) = if global.is_none() {
                tracing::warn!(event = "transport.backpressure", request_id = %request.request_id,
                    session_id = %request.session_id, "Control execution budget exhausted");
                (
                    WireEnvelope {
                        request_id: request.request_id,
                        session_id: request.session_id,
                        body: Some(wire_envelope::Body::Error(WireError {
                            code: "BACKPRESSURE".into(),
                            message: "control execution budget exhausted".into(),
                            expected: None,
                            actual: None,
                        })),
                        ..Default::default()
                    },
                    false,
                )
            } else {
                execute(request).await
            };
            let response = if response.encoded_len() > MAX_FRAME_BYTES {
                WireEnvelope {
                    request_id: if response.request_id.len() <= 256 {
                        response.request_id
                    } else {
                        String::new()
                    },
                    body: Some(wire_envelope::Body::Error(WireError {
                        code: "RESPONSE_TOO_LARGE".into(),
                        message: "control response exceeds frame budget".into(),
                        expected: None,
                        actual: None,
                    })),
                    ..Default::default()
                }
            } else {
                response
            };
            let bytes = encode_wire(&response);
            let Ok(byte_permit) = response_budget.acquire_many_owned(bytes.len() as u32).await
            else {
                return;
            };
            let _ = responses
                .send(Reply {
                    bytes,
                    shutdown,
                    _local: permit,
                    _global: global,
                    _bytes: byte_permit,
                })
                .await;
        }.in_current_span());
        if stopping {
            break Ok(());
        }
    };
    // Accepted writes may still commit after a peer disconnect; keep their receipts durable.
    if timeout(DRAIN_TIMEOUT, async {
        while jobs.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        jobs.abort_all();
    }
    drop(responses);
    let written = match writer_result {
        Some(result) => result,
        None => match timeout(WRITE_TIMEOUT, &mut writer).await {
            Ok(result) => result,
            Err(_) => {
                writer.abort();
                return Err(TransportError::Protocol(
                    "control writer drain timed out".into(),
                ));
            }
        },
    };
    written.map_err(|error| TransportError::Protocol(error.to_string()))??;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::protocol::{WireAck, WireHealth, WireHealthResponse, WireShutdown};
    use tokio::sync::Notify;

    fn request(id: &str) -> WireEnvelope {
        WireEnvelope {
            request_id: id.into(),
            body: Some(wire_envelope::Body::Health(WireHealth {})),
            ..Default::default()
        }
    }
    #[tokio::test]
    async fn a_slow_request_does_not_block_another_response_on_the_same_connection() {
        let (server, mut client) = tokio::io::duplex(64 * 1024);
        let (shutdown, _rx) = watch::channel(false);
        let release = Arc::new(Notify::new());
        let gate = release.clone();
        let task = tokio::spawn(run(
            server,
            shutdown,
            Arc::new(ControlBudget::new()),
            move |request| {
                let gate = gate.clone();
                async move {
                    if request.request_id == "slow" {
                        gate.notified().await;
                    }
                    let stopping = matches!(request.body, Some(wire_envelope::Body::Shutdown(_)));
                    (
                        WireEnvelope {
                            request_id: request.request_id,
                            body: Some(if stopping {
                                wire_envelope::Body::Ack(WireAck {
                                    request: "shutdown".into(),
                                })
                            } else {
                                wire_envelope::Body::HealthResponse(WireHealthResponse {
                                    ok: true,
                                    protocol: "test".into(),
                                })
                            }),
                            ..Default::default()
                        },
                        stopping,
                    )
                }
            },
        ));
        write_frame(&mut client, &encode_wire(&request("slow")))
            .await
            .unwrap();
        write_frame(&mut client, &encode_wire(&request("fast")))
            .await
            .unwrap();
        let fast = timeout(Duration::from_secs(1), read_frame(&mut client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(decode_wire(&fast).unwrap().request_id, "fast");
        // Shutdown must drain the slow operation before its final acknowledgement.
        write_frame(
            &mut client,
            &encode_wire(&WireEnvelope {
                request_id: "stop".into(),
                body: Some(wire_envelope::Body::Shutdown(WireShutdown {})),
                ..Default::default()
            }),
        )
        .await
        .unwrap();
        release.notify_one();
        let slow = read_frame(&mut client).await.unwrap();
        assert_eq!(decode_wire(&slow).unwrap().request_id, "slow");
        let stopped = read_frame(&mut client).await.unwrap();
        assert_eq!(decode_wire(&stopped).unwrap().request_id, "stop");
        task.await.unwrap().unwrap();
    }
}
