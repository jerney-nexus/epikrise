use std::os::unix::{ffi::OsStrExt, fs::FileTypeExt};
use std::{env, fs, io, os::unix::process::CommandExt, path::Path, process::Command};

const SESSION_BUS_ADDRESS: &str = "DBUS_SESSION_BUS_ADDRESS";

pub(crate) fn exec_with_resolved_address() -> io::Result<()> {
    let Some(address) = resolve_linux_session_bus_address() else {
        return Ok(());
    };
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command
        .args(env::args_os().skip(1))
        .env(SESSION_BUS_ADDRESS, address);
    Err(command.exec())
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
    if address.contains('\0') {
        return None;
    }

    let mut has_listening_unix_socket = false;
    for entry in address.split(';') {
        let (transport, parameter_source) = entry.split_once(':')?;
        if transport.is_empty()
            || !transport
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            || parameter_source.is_empty()
        {
            return None;
        }

        let mut keys = std::collections::HashSet::new();
        let mut socket_type = None;
        let mut encoded_socket_name = None;
        for parameter in parameter_source.split(',') {
            let (key, value) = parameter.split_once('=')?;
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                || !keys.insert(key)
                || !has_valid_percent_encoding(value)
            {
                return None;
            }
            if key == "guid"
                && (value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            {
                return None;
            }
            if matches!(key, "path" | "abstract") {
                if socket_type.is_some() {
                    return None;
                }
                socket_type = Some(key);
                encoded_socket_name = Some(value);
            }
        }

        if transport != "unix" {
            continue;
        }
        let (Some(socket_type), Some(encoded_socket_name)) = (socket_type, encoded_socket_name)
        else {
            continue;
        };
        let socket_name = decode_percent_encoding(encoded_socket_name)?;
        if socket_name.contains(&0) {
            return None;
        }
        has_listening_unix_socket |= is_listening_unix_socket(socket_type, &socket_name);
    }

    has_listening_unix_socket.then(|| address.to_owned())
}

fn is_listening_unix_socket(socket_type: &str, socket_name: &[u8]) -> bool {
    if socket_type == "path" {
        let path = Path::new(std::ffi::OsStr::from_bytes(socket_name));
        if !fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket()) {
            return false;
        }
    }

    let Ok(proc_contents) = fs::read("/proc/net/unix") else {
        return false;
    };

    contains_listening_unix_socket(&proc_contents, socket_type, socket_name)
}

fn contains_listening_unix_socket(
    proc_contents: &[u8],
    socket_type: &str,
    socket_name: &[u8],
) -> bool {
    proc_contents
        .split(|byte| *byte == b'\n')
        .any(|line| matches_socket_entry(line, socket_type, socket_name))
}

fn matches_socket_entry(line: &[u8], socket_type: &str, socket_name: &[u8]) -> bool {
    let mut remaining = line;
    let mut flags = None;
    for column in 0..7 {
        while remaining.first().is_some_and(u8::is_ascii_whitespace) {
            remaining = &remaining[1..];
        }
        let Some(separator) = remaining.iter().position(u8::is_ascii_whitespace) else {
            return false;
        };
        let (field, rest) = remaining.split_at(separator);
        if column == 3 {
            flags = std::str::from_utf8(field)
                .ok()
                .and_then(|value| u32::from_str_radix(value, 16).ok());
        }
        remaining = rest;
    }

    let Some(path) = remaining.strip_prefix(b" ") else {
        return false;
    };
    if flags.is_none_or(|value| value & 0x0001_0000 == 0) {
        return false;
    }

    match socket_type {
        "path" => path == socket_name,
        "abstract" => path
            .strip_prefix(b"@")
            .is_some_and(|name| name == socket_name),
        _ => false,
    }
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

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        let Some(hex) = bytes.get(index + 1..index + 3) else {
            return false;
        };
        if !hex.iter().all(u8::is_ascii_hexdigit) {
            return false;
        }
        index += 3;
    }
    true
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        os::{
            linux::net::SocketAddrExt,
            unix::{
                ffi::OsStrExt,
                net::{SocketAddr, UnixListener},
            },
        },
        path::Path,
        process::{Command, Output},
    };

    use tempfile::tempdir;

    use epikrise_llm::KeyringCredentialStore;

    use super::{
        SESSION_BUS_ADDRESS, contains_listening_unix_socket, exec_with_resolved_address,
        resolve_address_from_record, resolve_linux_session_bus_address,
    };

    const STARTUP_TEST_MODE: &str = "EPIKRISE_LINUX_STARTUP_TEST_MODE";
    const STARTUP_TEST_CREDENTIAL: &str = "EPIKRISE_LINUX_STARTUP_TEST_CREDENTIAL";
    const STARTUP_TEST_ADDRESS: &str = "EPIKRISE_LINUX_STARTUP_TEST_ADDRESS";
    const STARTUP_TEST_SECRET: &str = "disposable Linux startup integration test";

    fn run_startup_test_process(
        mode: &str,
        credential_id: &str,
        address: &str,
        home_directory: Option<&Path>,
    ) -> Output {
        let mut command = Command::new(env::current_exe().expect("test executable path"));
        command
            .args(env::args_os().skip(1))
            .env(STARTUP_TEST_MODE, mode)
            .env(STARTUP_TEST_CREDENTIAL, credential_id)
            .env(STARTUP_TEST_ADDRESS, address)
            .env(SESSION_BUS_ADDRESS, address);
        if let Some(home_directory) = home_directory {
            command.env("HOME", home_directory);
        }
        command.output().expect("startup test subprocess")
    }

    fn assert_process_succeeded(output: &Output, action: &str) {
        assert!(
            output.status.success(),
            "{action} failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    #[ignore = "run with pnpm test:rust:linux-startup-integration"]
    fn linux_startup_reexec_resolves_autolaunch_and_lists_credentials() {
        let mode = env::var(STARTUP_TEST_MODE).ok();
        let credential_id = env::var(STARTUP_TEST_CREDENTIAL).ok();
        let expected_address = env::var(STARTUP_TEST_ADDRESS).ok();

        match mode.as_deref() {
            Some("seed") => {
                KeyringCredentialStore
                    .set(
                        credential_id.as_deref().expect("test credential id"),
                        STARTUP_TEST_SECRET,
                    )
                    .expect("seed disposable keyring credential");
                return;
            }
            Some("cleanup") => {
                KeyringCredentialStore
                    .delete(credential_id.as_deref().expect("test credential id"))
                    .expect("delete disposable keyring credential");
                return;
            }
            Some("launch") => {
                if env::var(SESSION_BUS_ADDRESS)
                    .is_ok_and(|address| address.starts_with("autolaunch:"))
                {
                    let result = exec_with_resolved_address();
                    panic!("expected process replacement, resolver returned {result:?}");
                }

                assert_eq!(
                    env::var(SESSION_BUS_ADDRESS).as_deref().ok(),
                    expected_address.as_deref()
                );
                let listed = KeyringCredentialStore
                    .list()
                    .expect("list credentials after startup re-exec");
                assert!(
                    listed
                        .iter()
                        .any(|credential| Some(credential.id.as_str()) == credential_id.as_deref()),
                    "re-executed process could not list the seeded credential"
                );
                return;
            }
            Some(other) => panic!("unexpected startup test mode: {other}"),
            None => {}
        }

        let bus_address = env::var(SESSION_BUS_ADDRESS)
            .ok()
            .filter(|address| !address.starts_with("autolaunch:"))
            .or_else(resolve_linux_session_bus_address)
            .expect("an active Linux session-bus address is required");
        let bus_address =
            resolve_address_from_record(&format!("DBUS_SESSION_BUS_ADDRESS='{bus_address}'\n"))
                .expect("session-bus address must refer to a listening Unix socket");
        let machine_id = fs::read_to_string("/etc/machine-id")
            .expect("machine id")
            .trim()
            .to_owned();
        let home_directory = tempdir().expect("temporary home directory");
        let session_bus_directory = home_directory.path().join(".dbus").join("session-bus");
        fs::create_dir_all(&session_bus_directory).expect("session-bus record directory");
        fs::write(
            session_bus_directory.join(format!("{machine_id}-1")),
            format!("DBUS_SESSION_BUS_ADDRESS='{bus_address}'\n"),
        )
        .expect("write temporary session-bus record");

        let credential_id = format!("open_ai:linux-startup-test-{}", std::process::id());
        let seed = run_startup_test_process("seed", &credential_id, &bus_address, None);
        assert_process_succeeded(&seed, "credential seeding");

        let launch = {
            let mut command = Command::new(env::current_exe().expect("test executable path"));
            command
                .args(env::args_os().skip(1))
                .env(STARTUP_TEST_MODE, "launch")
                .env(STARTUP_TEST_CREDENTIAL, &credential_id)
                .env(STARTUP_TEST_ADDRESS, &bus_address)
                .env("HOME", home_directory.path())
                .env("DISPLAY", ":1.0")
                .env(SESSION_BUS_ADDRESS, "autolaunch:");
            command.output().expect("launch re-exec integration test")
        };

        let cleanup = run_startup_test_process("cleanup", &credential_id, &bus_address, None);
        assert_process_succeeded(&cleanup, "credential cleanup");
        assert_process_succeeded(&launch, "autolaunch re-exec and credential listing");
    }

    #[test]
    fn resolves_a_live_socket_with_escaped_spaces_and_backslashes() {
        let directory = tempdir().expect("temporary directory");
        let socket_directory = directory.path().join("session  bus\\123");
        fs::create_dir(&socket_directory).expect("socket directory");
        let socket_path = socket_directory.join("bus");
        let _listener = UnixListener::bind(&socket_path).expect("session bus listener");
        let encoded_path = socket_path.to_string_lossy().replace(' ', "%20");
        let address = format!("unix:path={encoded_path},guid=0123456789abcdef0123456789abcdef");
        let record = format!("DBUS_SESSION_BUS_ADDRESS='{address}'\n");

        assert_eq!(resolve_address_from_record(&record), Some(address));
    }

    #[test]
    fn rejects_a_stale_socket_path() {
        let directory = tempdir().expect("temporary directory");
        let socket_path = directory.path().join("stale-bus");
        let listener = UnixListener::bind(&socket_path).expect("session bus listener");
        drop(listener);
        let address = format!(
            "unix:path={},guid=0123456789abcdef0123456789abcdef",
            socket_path.display()
        );
        let record = format!("DBUS_SESSION_BUS_ADDRESS='{address}'\n");

        assert!(socket_path.exists());
        assert_eq!(resolve_address_from_record(&record), None);
    }

    #[test]
    fn rejects_invalid_guid_and_malformed_trailing_parameters() {
        let directory = tempdir().expect("temporary directory");
        let socket_path = directory.path().join("live-bus");
        let _listener = UnixListener::bind(&socket_path).expect("session bus listener");

        for parameters in [
            "guid=not-a-guid",
            "guid=0123456789abcdef0123456789abcdef,malformed",
            "guid=0123456789abcdef0123456789abcdef,extra=%GG",
        ] {
            let record = format!(
                "DBUS_SESSION_BUS_ADDRESS='unix:path={},{}'\n",
                socket_path.display(),
                parameters
            );
            assert_eq!(resolve_address_from_record(&record), None, "{parameters}");
        }
    }

    #[test]
    fn rejects_percent_encoded_nul_in_path_and_abstract_socket_names() {
        assert_eq!(
            resolve_address_from_record(
                "DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/session%00bus,guid=0123456789abcdef0123456789abcdef'\n"
            ),
            None
        );
        assert_eq!(
            resolve_address_from_record(
                "DBUS_SESSION_BUS_ADDRESS='unix:abstract=session%00bus,guid=0123456789abcdef0123456789abcdef'\n"
            ),
            None
        );
    }

    #[test]
    fn rejects_literal_nul_elsewhere_in_a_live_socket_address() {
        let directory = tempdir().expect("temporary directory");
        let socket_path = directory.path().join("live-bus");
        let _listener = UnixListener::bind(&socket_path).expect("session bus listener");
        let address = format!(
            "unix:path={},guid=0123456789abcdef0123456789abcdef\0",
            socket_path.display()
        );
        let record = format!("DBUS_SESSION_BUS_ADDRESS='{address}'\n");

        assert_eq!(resolve_address_from_record(&record), None);
    }

    #[test]
    fn rejects_a_unlinked_live_socket_path() {
        let directory = tempdir().expect("temporary directory");
        let socket_path = directory.path().join("unlinked-bus");
        let _listener = UnixListener::bind(&socket_path).expect("session bus listener");
        fs::remove_file(&socket_path).expect("unlink session bus socket");
        let address = format!(
            "unix:path={},guid=0123456789abcdef0123456789abcdef",
            socket_path.display()
        );
        let record = format!("DBUS_SESSION_BUS_ADDRESS='{address}'\n");
        let proc_contents = fs::read("/proc/net/unix").expect("Unix socket table");

        assert!(contains_listening_unix_socket(
            &proc_contents,
            "path",
            socket_path.as_os_str().as_bytes()
        ));
        assert_eq!(resolve_address_from_record(&record), None);
    }

    #[test]
    fn resolves_a_live_abstract_socket() {
        let socket_name = b"epikrise-session-bus-test";
        let address = SocketAddr::from_abstract_name(socket_name).expect("abstract socket address");
        let _listener = UnixListener::bind_addr(&address).expect("session bus listener");
        let record = format!(
            "DBUS_SESSION_BUS_ADDRESS='unix:abstract={},guid=0123456789abcdef0123456789abcdef'\n",
            String::from_utf8_lossy(socket_name)
        );

        assert!(resolve_address_from_record(&record).is_some());
    }

    #[test]
    fn ignores_non_utf8_socket_paths_when_searching_the_kernel_table() {
        let proc_contents = b"Num RefCount Protocol Flags Type St Inode Path\n\
0000000000000001: 00000002 00000000 00010000 0001 01 1234 /tmp/unrelated-\xff\n\
0000000000000002: 00000002 00000000 00010000 0001 01 1235 /run/dbus/session\n";

        assert!(contains_listening_unix_socket(
            proc_contents,
            "path",
            b"/run/dbus/session"
        ));
    }
}
