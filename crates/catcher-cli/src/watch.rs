// `catcher watch` plumbing: the realtime WebSocket (signals only, content always comes from the inbox), the
// fallback poll timer, and running the --exec handler through the shell.

use std::io::Write;
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use tungstenite::Message;
use tungstenite::stream::MaybeTlsStream;

use crate::agent::encode_uri_component;
use crate::auth::{now_ms, sign_request};

/// Runs `cmd` through the shell with `input` on stdin. Returns the exit code (1 when killed or not started).
pub fn run_handler(cmd: &str, input: &str, env: &[(&str, String)]) -> i32 {
    let mut command = shell(cmd);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    for (k, v) in env {
        command.env(k, v);
    }
    let Ok(mut child) = command.spawn() else {
        return 1;
    };
    let writer = child.stdin.take().map(|mut stdin| {
        let input = input.to_string();
        // a handler that never reads stdin must not block us: write from a thread, ignore a closed pipe
        std::thread::spawn(move || {
            let _ = stdin.write_all(input.as_bytes());
        })
    });
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
    if let Some(w) = writer {
        let _ = w.join();
    }
    code
}

#[cfg(not(windows))]
fn shell(cmd: &str) -> Command {
    let mut c = Command::new("/bin/sh");
    c.arg("-c").arg(cmd);
    c
}

#[cfg(windows)]
fn shell(cmd: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let mut c = Command::new(comspec);
    c.raw_arg(format!("/d /s /c \"{cmd}\""));
    c
}

/// Wakeups for the drain loop: one per realtime signal, plus the fallback interval.
pub struct Signals {
    tx: Sender<()>,
    rx: Receiver<()>,
}

impl Default for Signals {
    fn default() -> Self {
        Self::new()
    }
}

impl Signals {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        Signals { tx, rx }
    }

    pub fn sender(&self) -> Sender<()> {
        self.tx.clone()
    }

    /// Never returns. Signals that arrive while a drain runs collapse into one more drain.
    pub fn run(&self, interval_ms: f64, mut drain: impl FnMut()) {
        let interval = Duration::from_millis(interval_ms.max(1.0) as u64);
        let mut next_tick = Instant::now() + interval;
        loop {
            let wait = next_tick.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(wait) {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => next_tick = Instant::now() + interval,
                // we hold a sender ourselves, so this cannot happen
                Err(RecvTimeoutError::Disconnected) => std::thread::sleep(wait),
            }
            loop {
                drain();
                // anything that arrived during the drain: one more pass
                let mut again = false;
                while self.rx.try_recv().is_ok() {
                    again = true;
                }
                if !again {
                    break;
                }
            }
        }
    }
}

const PING_EVERY: Duration = Duration::from_secs(30);

/// Keep a realtime stream open in the background; reconnect with backoff (2s doubling to 60s).
pub fn connect_stream(server: &str, agent_id: &str, sign_secret: [u8; 32], signal: Sender<()>) {
    let server = server.to_string();
    let agent_id = agent_id.to_string();
    std::thread::spawn(move || {
        let mut delay: u64 = 1000;
        loop {
            let auth = sign_request(&agent_id, &sign_secret, "GET", "/v1/stream", &[], now_ms());
            let base = server
                .strip_prefix("http")
                .map(|rest| format!("ws{rest}"))
                .unwrap_or_else(|| server.clone());
            let url = format!("{base}/v1/stream?auth={}", encode_uri_component(&auth));
            if let Ok((mut ws, _)) = tungstenite::connect(url.as_str()) {
                delay = 1000;
                let tcp: Option<&TcpStream> = match ws.get_ref() {
                    MaybeTlsStream::Plain(s) => Some(s),
                    MaybeTlsStream::Rustls(s) => Some(s.get_ref()),
                    _ => None,
                };
                if let Some(tcp) = tcp {
                    let _ = tcp.set_read_timeout(Some(Duration::from_secs(5)));
                }
                let mut last_ping = Instant::now();
                loop {
                    if last_ping.elapsed() >= PING_EVERY {
                        last_ping = Instant::now();
                        if ws.send(Message::text("ping")).is_err() {
                            break;
                        }
                    }
                    match ws.read() {
                        Ok(Message::Text(t)) if t.as_str() == "pong" => {}
                        Ok(Message::Text(_) | Message::Binary(_)) => {
                            if signal.send(()).is_err() {
                                return;
                            }
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e))
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => break,
                    }
                }
            }
            delay = (delay * 2).min(60_000);
            std::thread::sleep(Duration::from_millis(delay));
        }
    });
}
