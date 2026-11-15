// Local files: everything an agent keeps lives under CATCHER_HOME (default ~/.catcher), one folder per profile,
// readable only by the user: state (secret seed), the verified-directory cache, the message history, acked ids.
// Same formats as the TS CLI, so either CLI can use a profile the other made.

use std::fs;
use std::io::Write;
use std::path::Path;

use crate::error::Error;
use crate::json::{self, Obj, Value, to_js_string};
use crate::paths::{env_nonempty, home_dir, join};

pub const DEFAULT_SERVER: &str = "https://catcher.bang9.dev";

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
                    "no agent in profile \"{}\" — run: catcher register --code <code> --name <name>",
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
