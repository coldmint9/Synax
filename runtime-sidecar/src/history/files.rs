//! Native file before-images and mutation ownership. No SQL or Node snapshot store.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileVersion { kind: String, hash: String, mode: u32, size: u64, blob_id: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
struct FileChange { root: String, path: String, before: Option<FileVersion>, after: Option<FileVersion>, #[serde(default)] git: Option<serde_json::Value> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mutation {
    id: String, session_id: String, source_session_id: String, sequence: u64,
    owner_pid: u32, state: String, untracked: bool, created_at: String,
    #[serde(default)] warning: Option<String>,
    roots: Vec<String>, changes: Vec<FileChange>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Restore {
    session_id: String, request_id: String, checkpoint_id: String,
    target: String, expected_revision: u64, files: Vec<FileChange>,
    metadata: serde_json::Value, state: String,
}
const STREAM_CHUNK: usize = 256 * 1024;
const MAX_CAPTURE_BYTES: u64 = 256 * 1024 * 1024;
fn mutation_key(id: &str) -> String { format!("m/{id}") }
fn claim_key(file: &Path) -> String { format!("p/{}", encode_hex(file.to_string_lossy().as_bytes())) }
fn counter_key(session: &str) -> String { format!("n/{}", encode_hex(session.as_bytes())) }
fn restore_key(session: &str) -> String { format!("r/{}", encode_hex(session.as_bytes())) }
fn same(a: &Option<FileVersion>, b: &Option<FileVersion>) -> bool {
    match (a,b) { (None,None) => true, (Some(a),Some(b)) => a.kind==b.kind && a.hash==b.hash && a.mode==b.mode, _ => false }
}
fn target(root: &str, relative: &str) -> Result<PathBuf, HistoryError> {
    let root = Path::new(root);
    let canonical=root.canonicalize()?;
    #[cfg(windows)]
    let canonical={let text=canonical.to_string_lossy();PathBuf::from(if let Some(unc)=text.strip_prefix(r"\\?\UNC\"){format!(r"\\{unc}")}else{text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()})};
    if !root.is_absolute() || canonical != root || relative.is_empty()
        || Path::new(relative).components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(HistoryError::InvalidCommand("file target is not workspace-relative".into()));
    }
    let file = root.join(relative);
    let mut parent = file.parent();
    while let Some(dir) = parent {
        if dir == root { break; }
        match fs::symlink_metadata(dir) {
            Ok(stat) if !stat.is_dir() || stat.file_type().is_symlink() => return Err(HistoryError::InvalidCommand("file ancestor is not an ordinary directory".into())),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        parent = dir.parent();
    }
    Ok(file)
}
fn mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; metadata.permissions().mode() & 0o777 }
    #[cfg(not(unix))] { u32::from(metadata.permissions().readonly()) }
}

impl HistoryStore {
    fn file_snapshot(&self, file: &Path, persist: bool, final_batch: &mut WriteBatch) -> Result<Option<FileVersion>, HistoryError> {
        let before = match fs::symlink_metadata(file) { Ok(value) => value, Err(error) if error.kind()==std::io::ErrorKind::NotFound => return Ok(None), Err(error) => return Err(error.into()) };
        let link = before.file_type().is_symlink();
        if before.len()>MAX_CAPTURE_BYTES {return Err(HistoryError::InvalidCommand("file image exceeds the 256 MiB capture limit".into()));}
        if !link && !before.is_file() { return Err(HistoryError::InvalidCommand("only ordinary files and symlinks can be checkpointed".into())); }
        let mut reader: Box<dyn Read> = if link { Box::new(std::io::Cursor::new(fs::read_link(file)?.to_string_lossy().as_bytes().to_vec())) } else { Box::new(File::open(file)?) };
        let blob_id = if persist { format!("file-{}", uuid::Uuid::new_v4()) } else { String::new() };
        let mut digest = Sha256::new(); let mut size = 0u64; let mut chunks = 0u64;
        let mut buffer = vec![0; STREAM_CHUNK]; let mut batch = WriteBatch::default();
        loop {
            let length = reader.read(&mut buffer)?;
            if length == 0 && chunks > 0 { break; }
            digest.update(&buffer[..length]); size += length as u64;
            if !link && size>before.len() {return Err(HistoryError::FileBusy("file grew during image capture".into()));}
            if persist { batch.put_cf(self.cf(CF_BLOBS)?, blob_chunk_key(&blob_id,chunks), &buffer[..length]); }
            chunks += 1;
            if persist && chunks % 4 == 0 { self.db.write(batch)?; batch = WriteBatch::default(); }
            if length == 0 { break; }
        }
        let after = fs::symlink_metadata(file)?;
        #[cfg(unix)]
        let same_inode={use std::os::unix::fs::MetadataExt;before.dev()==after.dev()&&before.ino()==after.ino()&&before.ctime()==after.ctime()&&before.ctime_nsec()==after.ctime_nsec()};
        #[cfg(not(unix))]
        let same_inode=true;
        if !same_inode || before.len()!=after.len() || before.modified()?!=after.modified()? || before.file_type()!=after.file_type() || mode(&before)!=mode(&after) {
            return Err(HistoryError::FileBusy("file changed while its image was being captured".into()));
        }
        let hash = format!("{:x}", digest.finalize());
        if persist {
            self.db.write(batch)?;
            final_batch.put_cf(self.cf(CF_BLOBS)?, blob_manifest_key(&blob_id), serde_json::to_vec(&serde_json::json!({"blobId":blob_id,"total":chunks,"size":size,"sha256":hash}))?);
        }
        Ok(Some(FileVersion { kind: if link {"symlink"} else {"file"}.into(), hash, mode:mode(&before), size, blob_id }))
    }

    fn pending_mutations(&self) -> Result<Vec<Mutation>, HistoryError> {
        let mut items = Vec::new();
        for entry in self.db.iterator_cf(self.cf(CF_FILES)?, rocksdb::IteratorMode::From(b"a/", rocksdb::Direction::Forward)) {
            let (key,value) = entry?; if !key.starts_with(b"a/") { break; }
            let item: Mutation = serde_json::from_slice(&value)?;
            if item.state == "open" { items.push(item); }
        }
        Ok(items)
    }
    fn pending_restores(&self) -> Result<Vec<Restore>, HistoryError> {
        let mut items = Vec::new();
        for entry in self.db.iterator_cf(self.cf(CF_FILES)?, rocksdb::IteratorMode::From(b"r/", rocksdb::Direction::Forward)) {
            let (key,value) = entry?; if !key.starts_with(b"r/") { break; }
            items.push(serde_json::from_slice(&value)?);
        }
        Ok(items)
    }
    fn release_file_claims(&self, item: &Mutation, batch: &mut WriteBatch) -> Result<(),HistoryError> {
        for change in &item.changes { batch.delete_cf(self.cf(CF_FILES)?, claim_key(&target(&change.root,&change.path)?)); }
        Ok(())
    }
    fn save_mutation(&self, item: &Mutation, batch: &mut WriteBatch) -> Result<(),HistoryError> {
        let bytes=serde_json::to_vec(item)?;
        batch.put_cf(self.cf(CF_FILES)?, mutation_key(&item.id), &bytes);
        if item.state=="open" { batch.put_cf(self.cf(CF_FILES)?,format!("a/{}",item.id),bytes); }
        else { batch.delete_cf(self.cf(CF_FILES)?,format!("a/{}",item.id)); }
        Ok(())
    }

    fn checkpoint_data(&self, session: &str, id: &str) -> Result<serde_json::Value,HistoryError> {
        let bytes=self.get(CF_PINS,pin_key(session,id).as_bytes())?.ok_or_else(||HistoryError::ObjectMissing(format!("checkpoint {id}")))?;
        let value: serde_json::Value=serde_json::from_slice(&bytes)?;
        required_string(&value,"objectId")?;
        Ok(value)
    }
    fn restore_plan(&self, session: &str, cursor: u64) -> Result<(Vec<FileChange>,Vec<serde_json::Value>,Vec<String>),HistoryError> {
        let mut files: BTreeMap<String,FileChange>=BTreeMap::new();
        let mut blocked=BTreeSet::new(); let mut preserved=Vec::new(); let mut warnings=Vec::new();
        let mut next=serde_json::Value::Null;
        loop {
            let page:serde_json::Value=serde_json::from_slice(&self.list_indexed(session,"file_change",&serde_json::json!({"cursor":next,"reverse":true}))?)?;
            for value in page["items"].as_array().unwrap() {
                let item:Mutation=serde_json::from_value(value.clone())?;
                if item.sequence<=cursor { continue; }
                if item.untracked {
                    warnings.push(item.warning.clone().unwrap_or_else(||format!("Untracked effects from operation {} are preserved.",item.id)));
                    for change in &item.changes {
                        let key=serde_json::to_string(&(&change.root,&change.path))?;
                        blocked.insert(key.clone());
                        if !files.contains_key(&key) {preserved.push(serde_json::json!({"root":change.root,"path":change.path,"reason":"Manual or untracked changes are preserved."}));}
                    }
                    continue;
                }
                for change in item.changes {
                    let key=serde_json::to_string(&(&change.root,&change.path))?;
                    if blocked.contains(&key) { continue; }
                    if let Some(existing)=files.get_mut(&key) { existing.before=change.before;existing.git=change.git; }
                    else { files.insert(key,change); }
                }
            }
            next=page["cursor"].clone(); if next.is_null() { break; }
        }
        Ok((files.into_values().filter(|c|!same(&c.before,&c.after)).collect(),preserved,warnings))
    }
    fn file_preview(&self, session: &str, value: &serde_json::Value) -> Result<Vec<u8>,HistoryError> {
        let checkpoint=self.checkpoint_data(session,required_string(value,"checkpointId")?)?;
        let cursor=required_u64(&checkpoint["metadata"],"fileCursor")?;
        let (files,preserved,warnings)=self.restore_plan(session,cursor)?;
        let mut conflicts=Vec::new();
        for change in &files {
            let actual=target(&change.root,&change.path).and_then(|file|self.file_snapshot(&file,false,&mut WriteBatch::default()));
            match actual {
                Ok(version) if same(&version,&change.after) => {},
                Ok(_) => conflicts.push(serde_json::json!({"root":change.root,"path":change.path,"reason":"File has independent changes."})),
                Err(error) => conflicts.push(serde_json::json!({"root":change.root,"path":change.path,"reason":error.to_string()})),
            }
        }
        Ok(serde_json::to_vec(&serde_json::json!({"files":files,"conflicts":conflicts,"preservedFiles":preserved,"warnings":warnings}))?)
    }
    fn write_file_version(&self, change: &FileChange) -> Result<(),HistoryError> {
        let file=target(&change.root,&change.path)?;
        let Some(version)=&change.before else {
            match fs::remove_file(&file) { Ok(())=>{}, Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{}, Err(error)=>return Err(error.into()) }
            #[cfg(unix)] if let Some(parent)=file.parent(){File::open(parent)?.sync_all()?;}
            return Ok(());
        };
        let manifest=self.get_blob_manifest_value(&version.blob_id)?.ok_or_else(||HistoryError::ObjectMissing(version.blob_id.clone()))?;
        let count=required_u64(&manifest,"total")?;
        fs::create_dir_all(file.parent().unwrap())?;
        let temporary=file.parent().unwrap().join(format!(".synax-restore-{}",uuid::Uuid::new_v4()));
        let result=(|| -> Result<(),HistoryError> {
            let mut digest=Sha256::new(); let mut link=Vec::new();
            let mut output=if version.kind=="file" {Some(fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?)} else {None};
            for i in 0..count {
                let bytes=self.get(CF_BLOBS,blob_chunk_key(&version.blob_id,i).as_bytes())?.ok_or_else(||HistoryError::ObjectMissing(format!("blob {}/{i}",version.blob_id)))?;
                digest.update(&bytes);
                if let Some(file)=&mut output {file.write_all(&bytes)?;} else {link.extend(bytes);}
            }
            if format!("{:x}",digest.finalize())!=version.hash {return Err(HistoryError::InvalidCommand("file image checksum mismatch".into()));}
            if let Some(output)=output {
                #[cfg(unix)] {use std::os::unix::fs::PermissionsExt; output.set_permissions(fs::Permissions::from_mode(version.mode))?;}
                #[cfg(not(unix))] {let mut permissions=output.metadata()?.permissions();permissions.set_readonly(version.mode!=0);output.set_permissions(permissions)?;}
                output.sync_all()?;
            } else {
                let destination=String::from_utf8(link).map_err(|_|HistoryError::InvalidCommand("invalid symlink image".into()))?;
                #[cfg(unix)] std::os::unix::fs::symlink(destination,&temporary)?;
                #[cfg(windows)] std::os::windows::fs::symlink_file(destination,&temporary)?;
            }
            fs::rename(&temporary,&file)?;
            #[cfg(unix)] File::open(file.parent().unwrap())?.sync_all()?;
            Ok(())
        })();
        if fs::symlink_metadata(&temporary).is_ok() {let _=fs::remove_file(&temporary);}
        result
    }
    fn resume_restore(&self, restore: &mut Restore, batch: &mut WriteBatch) -> Result<(),HistoryError> {
        if restore.state=="head_committed" {return Ok(());}
        let head=self.read_head(&restore.session_id)?;
        if head.revision!=restore.expected_revision {return Err(HistoryError::RevisionConflict{expected:restore.expected_revision,actual:head.revision});}
        for change in &restore.files {
            let actual=self.file_snapshot(&target(&change.root,&change.path)?,false,&mut WriteBatch::default())?;
            if !same(&actual,&change.before) && !same(&actual,&change.after) {return Err(HistoryError::FileBusy(format!("independent change at {}/{}",change.root,change.path)));}
        }
        for change in &restore.files {
            let actual=self.file_snapshot(&target(&change.root,&change.path)?,false,&mut WriteBatch::default())?;
            if !same(&actual,&change.before) {self.write_file_version(change)?;}
        }
        self.head_switch(&restore.session_id,&serde_json::json!({"objectId":restore.target,"expectedRevision":restore.expected_revision}),"head_switch",batch)?;
        restore.state="head_committed".into();
        batch.put_cf(self.cf(CF_FILES)?,restore_key(&restore.session_id),serde_json::to_vec(restore)?);
        Ok(())
    }
    fn restore_checkpoint(&self, session: &str, request: &str, value: &serde_json::Value, batch: &mut WriteBatch) -> Result<Vec<u8>,HistoryError> {
        let id=required_string(value,"checkpointId")?;
        let mut restore=if let Some(bytes)=self.get(CF_FILES,restore_key(session).as_bytes())? {
            let existing:Restore=serde_json::from_slice(&bytes)?;
            if existing.request_id!=request || existing.checkpoint_id!=id {return Err(HistoryError::FileBusy("another restore is pending".into()));}
            existing
        } else {
            let checkpoint=self.checkpoint_data(session,id)?;
            let revision=required_u64(value,"expectedRevision")?;
            if self.read_head(session)?.revision!=revision {return Err(HistoryError::RevisionConflict{expected:revision,actual:self.read_head(session)?.revision});}
            if self.pending_mutations()?.iter().any(|m|m.session_id==session) {return Err(HistoryError::FileBusy("session has an active file writer".into()));}
            let include=value["includeFiles"].as_bool().unwrap_or(true);
            let mut files=if include {self.restore_plan(session,required_u64(&checkpoint["metadata"],"fileCursor")?)?.0} else {Vec::new()};
            let preserved: BTreeSet<String>=value.get("preservePaths").map(|v|serde_json::from_value(v.clone())).transpose()?.unwrap_or_default();
            files.retain(|c|!preserved.contains(&serde_json::to_string(&(&c.root,&c.path)).unwrap()));
            if self.pending_mutations()?.iter().any(|m|m.roots.iter().any(|root|files.iter().any(|f|Path::new(root).starts_with(&f.root)||Path::new(&f.root).starts_with(root)))) {
                return Err(HistoryError::FileBusy("another workspace operation is still writing".into()));
            }
            for change in &files {
                let file=target(&change.root,&change.path)?;
                if self.get(CF_FILES,claim_key(&file).as_bytes())?.is_some() {return Err(HistoryError::FileBusy("a file has an active writer".into()));}
                if !same(&self.file_snapshot(&file,false,&mut WriteBatch::default())?,&change.after) {return Err(HistoryError::FileBusy(format!("independent change at {}",file.display())));}
            }
            let restore=Restore{session_id:session.into(),request_id:request.into(),checkpoint_id:id.into(),target:required_string(&checkpoint,"objectId")?.into(),expected_revision:revision,files,metadata:checkpoint["metadata"].clone(),state:"prepared".into()};
            // Filesystem writes and RocksDB cannot share a transaction. Persist
            // the exact plan first so a retry resumes partially applied files.
            let mut prepared=WriteBatch::default();prepared.put_cf(self.cf(CF_FILES)?,restore_key(session),serde_json::to_vec(&restore)?);
            let mut options=WriteOptions::default();options.set_sync(true);self.db.write_opt(prepared,&options)?;
            restore
        };
        self.resume_restore(&mut restore,batch)?;
        Ok(serde_json::to_vec(&serde_json::json!({"revision":restore.expected_revision+1,"metadata":restore.metadata,"requestId":restore.request_id}))?)
    }
    fn recover_files(&self, session: &str, batch: &mut WriteBatch) -> Result<Vec<u8>,HistoryError> {
        let Some(bytes)=self.get(CF_FILES,restore_key(session).as_bytes())? else {return Ok(b"{\"recovered\":false}".to_vec());};
        let mut restore:Restore=serde_json::from_slice(&bytes)?;
        self.resume_restore(&mut restore,batch)?;
        Ok(serde_json::to_vec(&serde_json::json!({"recovered":true,"revision":restore.expected_revision+1,"metadata":restore.metadata,"requestId":restore.request_id}))?)
    }

    pub(super) fn file_command(&self, session_id: &str, request_id: &str, operation: &str, value: &serde_json::Value, batch: &mut WriteBatch) -> Result<Vec<u8>,HistoryError> {
        match operation {
            "file_import" => {
                let records:Vec<Mutation>=serde_json::from_value(value["records"].clone())?;
                if records.len()>256 {return Err(HistoryError::InvalidCommand("file import requires at most 256 records".into()));}
                let mut floor=required_u64(value,"cursorFloor")?;
                let mut objects=Vec::new();
                for item in &records {
                    if item.session_id!=session_id || item.state!="closed" {return Err(HistoryError::InvalidCommand("file import scope or state mismatch".into()));}
                    floor=floor.max(item.sequence);
                    for change in &item.changes {for version in [&change.before,&change.after].into_iter().flatten() {
                        let manifest=self.get_blob_manifest_value(&version.blob_id)?.ok_or_else(||HistoryError::ObjectMissing(version.blob_id.clone()))?;
                        if manifest["sha256"]!=version.hash || manifest["size"]!=version.size {return Err(HistoryError::InvalidCommand("imported file image differs from its manifest".into()));}
                    }}
                    self.save_mutation(item,batch)?;
                    objects.push(serde_json::json!({"kind":"runtime.file_change","value":item}));
                }
                floor=floor.max(self.get(CF_FILES,counter_key(session_id).as_bytes())?.map(|b|serde_json::from_slice::<u64>(&b)).transpose()?.unwrap_or(0));
                batch.put_cf(self.cf(CF_FILES)?,counter_key(session_id),serde_json::to_vec(&floor)?);
                if !objects.is_empty(){self.append_entities(session_id,&serde_json::json!({"objects":objects}),batch)?;}
                Ok(serde_json::to_vec(&serde_json::json!({"imported":records.len(),"cursor":floor}))?)
            }
            "file_checkpoint" => {
                let pin=required_string(value,"pinId")?;
                if let Some(existing)=self.get(CF_PINS,pin_key(session_id,pin).as_bytes())? {return Ok(existing);}
                if self.pending_mutations()?.iter().any(|m|m.session_id==session_id) || self.get(CF_FILES,restore_key(session_id).as_bytes())?.is_some() {return Err(HistoryError::FileBusy("session has an unfinished file operation".into()));}
                let head=self.read_head(session_id)?;
                let root=head.object_id.ok_or_else(||HistoryError::InvalidCommand("checkpoint requires a history head".into()))?;
                let cursor=self.get(CF_FILES,counter_key(session_id).as_bytes())?.map(|bytes|serde_json::from_slice::<u64>(&bytes)).transpose()?.unwrap_or(0);
                let mut metadata=value["metadata"].clone();metadata["fileCursor"]=serde_json::json!(cursor);
                self.head_switch(session_id,&serde_json::json!({"pinId":pin,"objectId":root,"metadata":metadata}),"checkpoint",batch)
            }
            "file_pending" => {
                let items: Vec<_> = self.pending_mutations()?.into_iter().map(|m| serde_json::json!({"id":m.id,"sessionId":m.session_id,"ownerPid":m.owner_pid})).collect();
                let restores: Vec<_> = self.pending_restores()?.into_iter().map(|r| serde_json::json!({"sessionId":r.session_id,"requestId":r.request_id,"state":r.state})).collect();
                Ok(serde_json::to_vec(&serde_json::json!({"items":items,"restores":restores}))?)
            }
            "file_cursor" => {
                if self.pending_mutations()?.iter().any(|m| m.session_id==session_id) || self.get(CF_FILES,restore_key(session_id).as_bytes())?.is_some() {
                    return Err(HistoryError::FileBusy("session has an unfinished file operation".into()));
                }
                let cursor = self.get(CF_FILES,counter_key(session_id).as_bytes())?.map(|b| serde_json::from_slice::<u64>(&b)).transpose()?.unwrap_or(0);
                Ok(serde_json::to_vec(&serde_json::json!({"cursor":cursor}))?)
            }
            "file_begin" => {
                let targets = value["targets"].as_array().ok_or_else(|| HistoryError::InvalidCommand("file targets are required".into()))?;
                if targets.len()>256 {return Err(HistoryError::InvalidCommand("a file mutation supports at most 256 paths".into()));}
                let roots: Vec<String> = serde_json::from_value(value["roots"].clone())?;
                let paths = targets.iter().map(|v| target(required_string(v,"root")?,required_string(v,"path")?)).collect::<Result<Vec<_>,_>>()?;
                for file in &paths { if self.get(CF_FILES,claim_key(file).as_bytes())?.is_some() { return Err(HistoryError::FileBusy(file.display().to_string())); } }
                for restore in self.pending_restores()? {
                    if restore.session_id==session_id || restore.files.iter().any(|c| roots.iter().any(|r| Path::new(&c.root).starts_with(r) || Path::new(r).starts_with(&c.root))) {
                        return Err(HistoryError::FileBusy("workspace has a pending history restore".into()));
                    }
                }
                let untracked = value["external"].as_bool().unwrap_or(false) || targets.is_empty();
                if !untracked {
                    let mut total=0u64;
                    for path in &paths {match fs::symlink_metadata(path){Ok(stat)=>total=total.saturating_add(stat.len()),Err(error)if error.kind()==std::io::ErrorKind::NotFound=>{},Err(error)=>return Err(error.into())}}
                    if total>MAX_CAPTURE_BYTES {return Err(HistoryError::InvalidCommand("file mutation images exceed 256 MiB".into()));}
                }
                let mut others = self.pending_mutations()?;
                let overlaps = |other: &Mutation| other.roots.iter().any(|r| roots.iter().any(|s| Path::new(r).starts_with(s) || Path::new(s).starts_with(r)));
                let uncertain = untracked || others.iter().any(|m| m.untracked && overlaps(m));
                if untracked { for other in &mut others { if overlaps(other) { other.untracked=true; self.save_mutation(other,batch)?; } } }
                let sequence = self.get(CF_FILES,counter_key(session_id).as_bytes())?.map(|b| serde_json::from_slice::<u64>(&b)).transpose()?.unwrap_or(0)+1;
                let mut changes = Vec::new();
                for (entry,file) in targets.iter().zip(&paths) {
                    changes.push(FileChange { root:required_string(entry,"root")?.to_owned(), path:required_string(entry,"path")?.to_owned(), before:if untracked {None} else {self.file_snapshot(file,true,batch)?}, after:None, git:entry.get("git").cloned() });
                }
                let item = Mutation { id:uuid::Uuid::new_v4().to_string(),session_id:session_id.to_owned(),source_session_id:required_string(value,"sourceSessionId")?.to_owned(),sequence,owner_pid:required_u64(value,"ownerPid")? as u32,state:"open".into(),untracked:uncertain,created_at:now_iso(),warning:value["warning"].as_str().map(str::to_owned),roots,changes };
                for file in &paths { batch.put_cf(self.cf(CF_FILES)?,claim_key(file),item.id.as_bytes()); }
                batch.put_cf(self.cf(CF_FILES)?,counter_key(session_id),serde_json::to_vec(&sequence)?);
                self.save_mutation(&item,batch)?;
                Ok(serde_json::to_vec(&serde_json::json!({"id":item.id,"sequence":sequence}))?)
            }
            "file_finish" | "file_abandon" => {
                let id = required_string(value,"id")?;
                let bytes = self.get(CF_FILES,mutation_key(id).as_bytes())?.ok_or_else(|| HistoryError::ObjectMissing(id.into()))?;
                let mut item: Mutation = serde_json::from_slice(&bytes)?;
                if item.session_id!=session_id { return Err(HistoryError::InvalidCommand("file mutation belongs to another session".into())); }
                if item.state != "open" { return Ok(serde_json::to_vec(&item)?); }
                item.untracked |= operation=="file_abandon";
                if !item.untracked { for change in &mut item.changes { change.after=self.file_snapshot(&target(&change.root,&change.path)?,true,batch)?; } }
                self.release_file_claims(&item,batch)?;
                item.state = "closed".into();
                if !item.untracked { item.changes.retain(|change| !same(&change.before,&change.after)); }
                self.save_mutation(&item,batch)?;
                self.append_entities(session_id,&serde_json::json!({"objects":[{"kind":"runtime.file_change","value":item}]}),batch)?;
                Ok(serde_json::to_vec(&item)?)
            }
            "file_preview" => self.file_preview(session_id,value),
            "restore_checkpoint" => self.restore_checkpoint(session_id,request_id,value,batch),
            "file_recover" => self.recover_files(session_id,batch),
            "file_restore_ack" => {
                if let Some(bytes)=self.get(CF_FILES,restore_key(session_id).as_bytes())? {
                    let restore:Restore=serde_json::from_slice(&bytes)?;
                    if restore.request_id!=required_string(value,"requestId")? || restore.state!="head_committed" {return Err(HistoryError::FileBusy("restore acknowledgement does not match".into()));}
                    batch.delete_cf(self.cf(CF_FILES)?,restore_key(session_id));
                }
                Ok(b"{}".to_vec())
            }
            _ => Err(HistoryError::InvalidCommand("unknown file operation".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf,PathBuf,HistoryStore) {
        let root=std::env::temp_dir().join(format!("synax-native-files-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let workspace=root.join("workspace").canonicalize().unwrap();
        let store=HistoryStore::open(root.join("db")).unwrap();
        (root,workspace,store)
    }
    fn call(store:&HistoryStore, op:&str, body:serde_json::Value) -> serde_json::Value {
        serde_json::from_slice(&store.command("s",&uuid::Uuid::new_v4().to_string(),op,&serde_json::to_vec(&body).unwrap()).unwrap()).unwrap()
    }
    fn checkpoint(store:&HistoryStore) {
        call(store,"append_entities",serde_json::json!({"objects":[{"kind":"runtime.message","value":{"id":"original","sessionId":"s","sequence":1}}]}));
        call(store,"file_checkpoint",serde_json::json!({"pinId":"cp","metadata":{"kind":"input","messageId":"original"}}));
    }
    fn begin(store:&HistoryStore, workspace:&Path, paths:&[&str]) -> String {
        call(store,"file_begin",serde_json::json!({"sourceSessionId":"s","ownerPid":std::process::id(),"external":false,"roots":[workspace],"targets":paths.iter().map(|p|serde_json::json!({"root":workspace,"path":p})).collect::<Vec<_>>()}))["id"].as_str().unwrap().to_owned()
    }
    #[test]
    fn native_images_restore_changes_creations_and_deletions_after_reopen() {
        let (root,workspace,store)=fixture();
        fs::write(workspace.join("changed"),b"before").unwrap();fs::write(workspace.join("deleted"),b"restore me").unwrap();
        checkpoint(&store);
        let id=begin(&store,&workspace,&["changed","deleted","created"]);
        fs::write(workspace.join("changed"),vec![42;1024*1024+9]).unwrap();
        fs::remove_file(workspace.join("deleted")).unwrap();fs::write(workspace.join("created"),b"new").unwrap();
        call(&store,"file_finish",serde_json::json!({"id":id}));
        call(&store,"append_entities",serde_json::json!({"objects":[{"kind":"runtime.message","value":{"id":"later","sessionId":"s","sequence":2}}]}));
        drop(store);
        let store=HistoryStore::open(root.join("db")).unwrap();
        let preview=call(&store,"file_preview",serde_json::json!({"checkpointId":"cp"}));
        assert_eq!(preview["files"].as_array().unwrap().len(),3);assert!(preview["conflicts"].as_array().unwrap().is_empty());
        let revision=store.read_head("s").unwrap().revision;
        let result=call(&store,"restore_checkpoint",serde_json::json!({"checkpointId":"cp","expectedRevision":revision,"includeFiles":true}));
        assert_eq!(fs::read(workspace.join("changed")).unwrap(),b"before");
        assert_eq!(fs::read(workspace.join("deleted")).unwrap(),b"restore me");assert!(!workspace.join("created").exists());
        assert_eq!(call(&store,"list_messages",serde_json::json!({}))["items"].as_array().unwrap().len(),1);
        call(&store,"file_restore_ack",serde_json::json!({"requestId":result["requestId"]}));
        assert!(call(&store,"file_pending",serde_json::json!({}))["restores"].as_array().unwrap().is_empty());
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn manual_changes_are_not_overwritten_and_claims_exclude_competing_writers() {
        let (root,workspace,store)=fixture();fs::write(workspace.join("file"),b"before").unwrap();checkpoint(&store);
        let id=begin(&store,&workspace,&["file"]);
        assert!(matches!(store.command("other","competing","file_begin",&serde_json::to_vec(&serde_json::json!({"sourceSessionId":"other","ownerPid":1,"roots":[workspace],"targets":[{"root":workspace,"path":"file"}]})).unwrap()),Err(HistoryError::FileBusy(_))));
        fs::write(workspace.join("file"),b"agent").unwrap();call(&store,"file_finish",serde_json::json!({"id":id}));fs::write(workspace.join("file"),b"manual").unwrap();
        assert_eq!(call(&store,"file_preview",serde_json::json!({"checkpointId":"cp"}))["conflicts"].as_array().unwrap().len(),1);
        let revision=store.read_head("s").unwrap().revision;
        assert!(matches!(store.command("s","conflict","restore_checkpoint",&serde_json::to_vec(&serde_json::json!({"checkpointId":"cp","expectedRevision":revision})).unwrap()),Err(HistoryError::FileBusy(_))));
        assert_eq!(fs::read(workspace.join("file")).unwrap(),b"manual");assert!(store.get(CF_FILES,restore_key("s").as_bytes()).unwrap().is_none());
        drop(store);fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(unix)]
    fn rename_permissions_and_symlink_images_restore_without_following_links() {
        use std::os::unix::fs::{symlink,PermissionsExt};
        let (root,workspace,store)=fixture();
        fs::write(workspace.join("source"),b"original").unwrap();fs::set_permissions(workspace.join("source"),fs::Permissions::from_mode(0o600)).unwrap();
        symlink("source",workspace.join("link")).unwrap();checkpoint(&store);
        let id=begin(&store,&workspace,&["source","renamed","link"]);
        fs::rename(workspace.join("source"),workspace.join("renamed")).unwrap();fs::set_permissions(workspace.join("renamed"),fs::Permissions::from_mode(0o755)).unwrap();
        fs::remove_file(workspace.join("link")).unwrap();symlink("renamed",workspace.join("link")).unwrap();
        call(&store,"file_finish",serde_json::json!({"id":id}));
        let revision=store.read_head("s").unwrap().revision;
        call(&store,"restore_checkpoint",serde_json::json!({"checkpointId":"cp","expectedRevision":revision}));
        assert_eq!(fs::read(workspace.join("source")).unwrap(),b"original");assert!(!workspace.join("renamed").exists());
        assert_eq!(fs::metadata(workspace.join("source")).unwrap().permissions().mode()&0o777,0o600);
        assert_eq!(fs::read_link(workspace.join("link")).unwrap(),PathBuf::from("source"));
        drop(store);fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_multi_file_restore_resumes_the_saved_plan_after_reopen() {
        let (root,workspace,store)=fixture();
        for name in ["a","b"] {fs::write(workspace.join(name),format!("old-{name}")).unwrap();}
        checkpoint(&store);let id=begin(&store,&workspace,&["a","b"]);
        for name in ["a","b"] {fs::write(workspace.join(name),format!("new-{name}")).unwrap();}
        let mutation=call(&store,"file_finish",serde_json::json!({"id":id}));
        let blob=mutation["changes"][1]["before"]["blobId"].as_str().unwrap();let key=blob_chunk_key(blob,0);
        let saved=store.get(CF_BLOBS,key.as_bytes()).unwrap().unwrap();store.db.delete_cf(store.cf(CF_BLOBS).unwrap(),key.as_bytes()).unwrap();
        let revision=store.read_head("s").unwrap().revision;
        assert!(store.command("s","restore","restore_checkpoint",&serde_json::to_vec(&serde_json::json!({"checkpointId":"cp","expectedRevision":revision})).unwrap()).is_err());
        assert_eq!(fs::read(workspace.join("a")).unwrap(),b"old-a");assert_eq!(fs::read(workspace.join("b")).unwrap(),b"new-b");
        drop(store);let store=HistoryStore::open(root.join("db")).unwrap();store.db.put_cf(store.cf(CF_BLOBS).unwrap(),key.as_bytes(),saved).unwrap();
        let result=call(&store,"file_recover",serde_json::json!({}));assert_eq!(result["recovered"],true);
        assert_eq!(fs::read(workspace.join("b")).unwrap(),b"old-b");assert_eq!(store.read_head("s").unwrap().revision,revision+1);
        call(&store,"file_restore_ack",serde_json::json!({"requestId":"restore"}));
        drop(store);fs::remove_dir_all(root).unwrap();
    }
}
