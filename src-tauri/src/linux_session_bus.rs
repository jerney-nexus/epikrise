use std::{
    env, fs, io,
    os::{
        linux::net::SocketAddrExt,
        unix::{
            ffi::OsStringExt,
            net::{SocketAddr, UnixStream},
        },
    },
    path::{Path, PathBuf},
    process::Command,
};

const SESSION_BUS_ADDRESS: &str = "DBUS_SESSION_BUS_ADDRESS";

pub(crate) fn relaunch_with_resolved_address() -> io::Result<bool> {
    let Some(address) = resolve_linux_session_bus_address() else {
        return Ok(false);
    };
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .args(env::args_os().skip(1))
        .env(SESSION_BUS_ADDRESS, address);
    command.spawn()?;
    Ok(true)
}

fn resolve_linux_session_bus_address() -> Option<String> {
    let current_address = env::var(SESSION_BUS_ADDRESS).ok()?;
    if !current_address.starts_with("autolaunch:") {
        return None;
    }

    let display = env::var("DISPLAY").ok()?;
    let display_number = display.rsplit(':').next()?.split('.').next()?;
    if display_number.is_empty() || !display_number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let machine_id = fs::read_to_string("/etc/machine-id").ok()?;
    let machine_id = machine_id.trim();
    if machine_id.len() != 32 || !machine_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }

    let home_directory = env::var_os("HOME")?;
    let record_path = Path::new(&home_directory)
        .join(".dbus")
        .join("session-bus")
        .join(format!("{machine_id}-{display_number}"));
    let record = fs::read_to_string(record_path).ok()?;
    resolve_address_from_record(&record)
}

fn resolve_address_from_record(record: &str) -> Option<String> {
    let value = record
        .lines()
        .find_map(|line| line.strip_prefix("DBUS_SESSION_BUS_ADDRESS="))?
        .trim();
    let address = if let Some(value) = value.strip_prefix('"') {
        value.strip_suffix('"')?
    } else if let Some(value) = value.strip_prefix('\'') {
        value.strip_suffix('\'')?
    } else {
        value
    };

    let (socket_type, encoded_name) = address
        .strip_prefix("unix:")?
        .split(',')
        .next()?
        .split_once('=')?;
    let socket_name = decode_percent_encoding(encoded_name)?;
    let reachable = match socket_type {
        "path" => {
            let path = PathBuf::from(std::ffi::OsString::from_vec(socket_name));
            UnixStream::connect(path).is_ok()
        }
        "abstract" => SocketAddr::from_abstract_name(&socket_name)
            .and_then(|address| UnixStream::connect_addr(&address))
            .is_ok(),
        _ => false,
    };

    reachable.then(|| address.to_owned())
}

fn decode_percent_encoding(value: &str) -> Option<Vec<u8>> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            decoded.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    Some(decoded)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        os::{
            linux::net::SocketAddrExt,
            unix::net::{SocketAddr, UnixListener},
        },
    };

    use tempfile::tempdir;

    use super::resolve_address_from_record;

    #[test]
    fn resolves_a_reachable_percent_escaped_socket_path() {
        let directory = tempdir().expect("temporary directory");
        let socket_directory = directory.path().join("session bus");
        fs::create_dir(&socket_directory).expect("socket directory");
        let socket_path = socket_directory.join("bus");
        let _listener = UnixListener::bind(&socket_path).expect("session bus listener");
        let encoded_path = socket_path.to_string_lossy().replace(' ', "%20");
        let address = format!("unix:path={encoded_path},guid=0123456789abcdef");
        let record = format!("DBUS_SESSION_BUS_ADDRESS='{address}'\n");

        assert_eq!(resolve_address_from_record(&record), Some(address));
    }

    #[test]
    fn rejects_a_stale_socket_path() {
        let directory = tempdir().expect("temporary directory");
        let socket_path = directory.path().join("stale-bus");
        let listener = UnixListener::bind(&socket_path).expect("session bus listener");
        drop(listener);
        let address = format!("unix:path={},guid=0123456789abcdef", socket_path.display());
        let record = format!("DBUS_SESSION_BUS_ADDRESS='{address}'\n");

        assert!(socket_path.exists());
        assert_eq!(resolve_address_from_record(&record), None);
    }

    #[test]
    fn resolves_a_reachable_abstract_socket() {
        let socket_name = b"epikrise-session-bus-test";
        let address = SocketAddr::from_abstract_name(socket_name).expect("abstract socket address");
        let _listener = UnixListener::bind_addr(&address).expect("session bus listener");
        let record = format!(
            "DBUS_SESSION_BUS_ADDRESS='unix:abstract={},guid=0123456789abcdef'\n",
            String::from_utf8_lossy(socket_name)
        );

        assert!(resolve_address_from_record(&record).is_some());
    }
}
