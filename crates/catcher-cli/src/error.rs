// One error type that mirrors the TS classes: CliError (exit code), PolicyError (code), ApiError (status + code),
// and plain errors (optionally carrying an exit code, like the "no agent in profile" error).

use std::fmt;

#[derive(Debug, Clone)]
pub enum Error {
    Cli {
        message: String,
        exit: i32,
    },
    Policy {
        code: String,
        message: String,
    },
    Api {
        status: u16,
        code: String,
        message: String,
    },
    Plain {
        message: String,
        exit: Option<i32>,
    },
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn cli(message: impl Into<String>, exit: i32) -> Self {
        Error::Cli {
            message: message.into(),
            exit,
        }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Error::cli(message, 2)
    }

    pub fn policy(code: &str, message: impl Into<String>) -> Self {
        Error::Policy {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn plain(message: impl Into<String>) -> Self {
        Error::Plain {
            message: message.into(),
            exit: None,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Error::Cli { message, .. }
            | Error::Policy { message, .. }
            | Error::Api { message, .. }
            | Error::Plain { message, .. } => message,
        }
    }

    pub fn policy_code(&self) -> Option<&str> {
        match self {
            Error::Policy { code, .. } => Some(code),
            _ => None,
        }
    }

    pub fn api_code(&self) -> Option<&str> {
        match self {
            Error::Api { code, .. } => Some(code),
            _ => None,
        }
    }

    /// Exit codes: 0 ok · 1 error · 2 usage · 3 pending · 4 timeout · 5 denied · 6 not registered/revoked/auth · 7 not allowed
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Cli { exit, .. } => *exit,
            Error::Policy { code, .. } if code == "not_certified" => 6,
            Error::Policy { .. } => 7,
            Error::Api { status, code, .. } => match status {
                401 => 6,
                403 if code.starts_with("agent_") => 6,
                403 | 404 => 7,
                _ => 1,
            },
            Error::Plain { exit, .. } => exit.unwrap_or(1),
        }
    }

    /// `error.code` in --json output
    pub fn json_code(&self) -> &str {
        match self {
            Error::Policy { code, .. } | Error::Api { code, .. } => code,
            _ => "error",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl From<String> for Error {
    fn from(message: String) -> Self {
        Error::plain(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Self {
        Error::plain(message)
    }
}
