use std::collections::VecDeque;

/// Acknowledgement-based credits cannot be inflated by duplicate or future ACKs.
pub struct CreditWindow {
    outstanding: VecDeque<(u64, usize)>,
    bytes: usize,
    last_sent: u64,
    last_ack: u64,
    max_events: usize,
    max_bytes: usize,
}
impl CreditWindow {
    pub fn new(after: u64, max_events: usize, max_bytes: usize) -> Self {
        Self {
            outstanding: VecDeque::new(),
            bytes: 0,
            last_sent: after,
            last_ack: after,
            max_events,
            max_bytes,
        }
    }
    pub fn available(&self, bytes: usize) -> bool {
        self.outstanding.len() < self.max_events
            && bytes <= self.max_bytes.saturating_sub(self.bytes)
    }
    pub fn sent(&mut self, sequence: u64, bytes: usize) -> Result<(), &'static str> {
        if sequence <= self.last_sent || !self.available(bytes) {
            return Err("invalid send window");
        }
        self.last_sent = sequence;
        self.bytes += bytes;
        self.outstanding.push_back((sequence, bytes));
        Ok(())
    }
    pub fn ack(&mut self, through: u64) -> Result<(), &'static str> {
        if through > self.last_sent {
            return Err("acknowledgement exceeds delivered cursor");
        }
        if through <= self.last_ack {
            return Ok(());
        }
        self.last_ack = through;
        while self
            .outstanding
            .front()
            .is_some_and(|(sequence, _)| *sequence <= through)
        {
            let (_, bytes) = self.outstanding.pop_front().unwrap();
            self.bytes -= bytes;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ack_replenishes_only_delivered_events_and_bytes() {
        let mut window = CreditWindow::new(10, 2, 100);
        window.sent(11, 80).unwrap();
        assert!(!window.available(21));
        window.sent(12, 20).unwrap();
        assert!(!window.available(1));
        assert!(window.ack(13).is_err());
        assert!(!window.available(1));
        window.ack(11).unwrap();
        assert!(window.available(80));
        window.ack(11).unwrap();
        assert!(!window.available(81));
        window.sent(13, 80).unwrap();
        assert!(!window.available(1));
        window.ack(13).unwrap();
        assert!(window.available(100));
    }
}
