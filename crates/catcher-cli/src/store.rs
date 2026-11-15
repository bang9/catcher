// Local files: everything an agent keeps lives under CATCHER_HOME (default ~/.catcher), one folder per profile,
// readable only by the user: state (secret seed), a registration in progress (pending.json: seed and code), the
// verified-directory cache, the message history, acked ids.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::Error;
use crate::json::{self, Obj, Value, to_js_string};
use crate::paths::{env_nonempty, home_dir, join};

/// The relay the CLI talks to unless --server / CATCHER_SERVER says otherwise.
pub const DEFAULT_SERVER: &str = "https://api.catcher.bang9.dev";
/// Where registration links point (`<site>/r#<code>`): the static website that hands the code to the app. A separate
/// origin from the relay; CATCHER_SITE overrides it.
pub const DEFAULT_SITE: &str = "https://catcher.bang9.dev";

pub fn site() -> String {
    env_nonempty("CATCHER_SITE").unwrap_or_else(|| DEFAULT_SITE.to_string())
}

pub fn catcher_home() -> String {
    env_nonempty("CATCHER_HOME").unwrap_or_else(|| join(&[&home_dir(), ".catcher"]))
}

fn valid_profile(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// `readFileSync(path, 'utf8')` with Node-style error text.
pub fn read_text(path: &str) -> Result<String, Error> {
    match fs::read(path) {
        Ok(b) => Ok(String::from_utf8_lossy(&b).into_owned()),
        Err(e) => Err(Error::plain(node_io_message(&e, "open", path))),
    }
}

pub fn node_io_message(e: &std::io::Error, syscall: &str, path: &str) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => format!("ENOENT: no such file or directory, {syscall} '{path}'"),
        PermissionDenied => format!("EACCES: permission denied, {syscall} '{path}'"),
        IsADirectory => "EISDIR: illegal operation on a directory, read".into(),
        _ => format!("{e}, {syscall} '{path}'"),
    }
}

fn ensure_dir(dir: &str) -> Result<(), Error> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir)
        .map_err(|e| Error::plain(node_io_message(&e, "mkdir", dir)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| Error::plain(node_io_message(&e, "chmod", dir)))?;
    }
    Ok(())
}

fn open_private(path: &str, append: bool) -> std::io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true);
    if append {
        o.append(true);
    } else {
        o.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

/// write-then-rename so a crash never leaves half a state file
fn write_private(path: &str, text: &str) -> Result<(), Error> {
    let tmp = format!("{path}.{}.tmp", std::process::id());
    let mut f =
        open_private(&tmp, false).map_err(|e| Error::plain(node_io_message(&e, "open", &tmp)))?;
    f.write_all(text.as_bytes())
        .map_err(|e| Error::plain(e.to_string()))?;
    drop(f);
    fs::rename(&tmp, path).map_err(|e| Error::plain(node_io_message(&e, "rename", &tmp)))
}

fn append_private(path: &str, text: &str) -> Result<(), Error> {
    let mut f =
        open_private(path, true).map_err(|e| Error::plain(node_io_message(&e, "open", path)))?;
    f.write_all(text.as_bytes())
        .map_err(|e| Error::plain(e.to_string()))
}

/// The agent's state file, kept as JSON so unknown keys and key order survive a round trip.
#[derive(Clone, Debug)]
pub struct AgentState {
    pub raw: Obj,
}

impl AgentState {
    pub fn text(&self, key: &str) -> String {
        match self.raw.get(key) {
            Some(Value::Str(s)) => s.clone(),
            other => to_js_string(other),
        }
    }

    pub fn server(&self) -> String {
        self.text("server")
    }
    pub fn agent_id(&self) -> String {
        self.text("agentId")
    }
    pub fn owner_id(&self) -> String {
        self.text("ownerId")
    }
    pub fn name(&self) -> String {
        self.text("name")
    }
    pub fn seed(&self) -> String {
        self.text("seed")
    }

    pub fn pin(&self) -> (String, String) {
        let pin = self.raw.get("ownerPin");
        let get = |k: &str| match pin.and_then(|p| p.get(k)) {
            Some(Value::Str(s)) => s.clone(),
            other => to_js_string(other),
        };
        (get("signPub"), get("boxPub"))
    }

    pub fn number(&self, key: &str) -> f64 {
        json::to_number(self.raw.get(key))
    }

    pub fn set(&mut self, key: &str, value: Value) {
        self.raw.set(key, value);
    }
}

pub struct Profile {
    pub name: String,
    pub dir: String,
}

/// Longer than any registration step holding the lock (a POST is at most 10 s connect + 300 s + 300 s).
const LOCK_STALE_MS: f64 = 15.0 * 60.0 * 1000.0;

fn lock_is_stale(path: &str) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        // gone meanwhile (try again) or unreadable: only age can tell
        return fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_millis() as f64 > LOCK_STALE_MS);
    };
    let mut parts = text.split_whitespace();
    let pid = parts.next().and_then(|p| p.parse::<u32>().ok());
    let since = parts.next().and_then(|t| t.parse::<f64>().ok());
    let (Some(pid), Some(since)) = (pid, since) else {
        // half-written by a process that died between create and write
        return fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 5);
    };
    crate::auth::now_ms() - since > LOCK_STALE_MS || !process_alive(pid)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks that the process exists; nothing is delivered
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    true
}

/// Held while registering; the lock file goes when this drops.
pub struct ProfileLock {
    path: String,
}

impl Drop for ProfileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl Profile {
    pub fn new(name: &str) -> Result<Self, Error> {
        if !valid_profile(name) {
            return Err(Error::plain(
                "profile must be lowercase letters, digits, - or _",
            ));
        }
        Ok(Profile {
            name: name.into(),
            dir: join(&[&catcher_home(), "profiles", name]),
        })
    }

    fn path(&self, file: &str) -> String {
        join(&[&self.dir, file])
    }

    pub fn exists(&self) -> bool {
        Path::new(&self.path("state.json")).exists()
    }

    pub fn load(&self) -> Result<AgentState, Error> {
        if !self.exists() {
            return Err(Error::Plain {
                message: format!(
                    "no agent in profile \"{}\" — run: catcher register --name <name>",
                    self.name
                ),
                exit: Some(6),
            });
        }
        let path = self.path("state.json");
        match json::parse(&read_text(&path)?)? {
            Value::Obj(raw) => Ok(AgentState { raw }),
            _ => Err(Error::plain("state.json is not an object")),
        }
    }

    pub fn save(&self, state: &AgentState) -> Result<(), Error> {
        ensure_dir(&self.dir)?;
        write_private(
            &self.path("state.json"),
            &format!(
                "{}\n",
                json::stringify_pretty(&Value::Obj(state.raw.clone()))
            ),
        )
    }

    /// A registration in progress: seed, code parts, name, server. Written before the relay hears of it.
    pub fn load_pending(&self) -> Option<Obj> {
        let text = fs::read(self.path("pending.json")).ok()?;
        match json::parse(&String::from_utf8_lossy(&text)).ok()? {
            Value::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn has_pending(&self) -> bool {
        Path::new(&self.path("pending.json")).exists()
    }

    pub fn save_pending(&self, pending: &Obj) -> Result<(), Error> {
        ensure_dir(&self.dir)?;
        write_private(
            &self.path("pending.json"),
            &format!("{}\n", json::stringify_pretty(&Value::Obj(pending.clone()))),
        )
    }

    pub fn delete_pending(&self) -> Result<(), Error> {
        let path = self.path("pending.json");
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::plain(node_io_message(&e, "unlink", &path))),
        }
    }

    /// Exclusive lock for creating or finalising a registration (an atomic create-new of register.lock holding the
    /// owner's pid and start time). Waits up to `wait_ms` for another holder. A lock whose process is gone, or that is
    /// older than any registration step can take (network timeouts included), is from a crashed process and is
    /// taken over.
    pub fn lock(&self, wait_ms: u64) -> Result<ProfileLock, Error> {
        ensure_dir(&self.dir)?;
        let path = self.path("register.lock");
        let started = std::time::Instant::now();
        loop {
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut f) => {
                    let _ = f.write_all(
                        format!("{} {}", std::process::id(), crate::auth::now_ms()).as_bytes(),
                    );
                    return Ok(ProfileLock { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if lock_is_stale(&path) {
                        let _ = fs::remove_file(&path);
                        continue;
                    }
                    if started.elapsed().as_millis() as u64 >= wait_ms {
                        return Err(Error::plain(
                            "another catcher process is registering this profile — try again in a moment",
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(Error::plain(node_io_message(&e, "open", &path))),
            }
        }
    }

    /// Last verified directory (re-verified on load: it is only a cache). Unreadable means none.
    pub fn load_directory(&self) -> Option<Value> {
        let text = fs::read(self.path("directory.json")).ok()?;
        json::parse(&String::from_utf8_lossy(&text)).ok()
    }

    pub fn save_directory(&self, entry: &Value) -> Result<(), Error> {
        ensure_dir(&self.dir)?;
        write_private(&self.path("directory.json"), &json::stringify(entry))
    }

    /// Decrypted history: the relay deletes delivered messages, so this file is the agent's record.
    pub fn record(&self, entry: &Value) -> Result<(), Error> {
        ensure_dir(&self.dir)?;
        append_private(
            &self.path("history.jsonl"),
            &format!("{}\n", json::stringify(entry)),
        )
    }

    pub fn history(&self) -> Result<Vec<Value>, Error> {
        let path = self.path("history.jsonl");
        if !Path::new(&path).exists() {
            return Ok(Vec::new());
        }
        let text = read_text(&path)?;
        // a torn line is skipped
        Ok(text
            .split('\n')
            .filter(|l| !json::js_trim(l).is_empty())
            .filter_map(|l| json::parse(l).ok())
            .collect())
    }

    /// Ids this agent acked: the relay serving one again is a replay.
    pub fn mark_acked(&self, ids: &[String]) -> Result<(), Error> {
        if ids.is_empty() {
            return Ok(());
        }
        ensure_dir(&self.dir)?;
        append_private(&self.path("acked.txt"), &format!("{}\n", ids.join("\n")))
    }

    pub fn acked_ids(&self) -> Result<std::collections::HashSet<String>, Error> {
        let path = self.path("acked.txt");
        if !Path::new(&path).exists() {
            return Ok(Default::default());
        }
        Ok(read_text(&path)?
            .split('\n')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect())
    }
}
