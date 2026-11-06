// Pure helpers for service.mjs: which service manager to use and the files it needs.
// Kept free of side effects so every platform's output can be tested on any machine.
import path from 'node:path';

export const LABEL = 'com.agent-connector';
export const UNIT = 'agent-connector.service';
export const RESTART_DELAY_MS = 15_000;

// systemd on Linux when it is PID 1 (root: system service, otherwise a user service);
// launchd on macOS (a per-user LaunchAgent); the built-in supervisor everywhere else,
// e.g. containers, Linux without systemd, or when --supervisor is given.
export function detectBackend({ platform, pid1, uid, forceSupervisor = false }) {
  if (forceSupervisor) return { kind: 'supervisor' };
  if (platform === 'linux' && pid1 === 'systemd') return { kind: 'systemd', scope: uid === 0 ? 'system' : 'user' };
  if (platform === 'darwin') return { kind: 'launchd' };
  return { kind: 'supervisor' };
}

// PATH for the service: node's own directory first, then the usual tool locations of each OS.
export function servicePath({ platform, execPath, envPath = '' }) {
  const extra = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin'];
  const dirs = [path.dirname(execPath), ...(platform === 'win32' ? envPath.split(';') : extra)].filter(Boolean);
  return [...new Set(dirs)].join(platform === 'win32' ? ';' : ':');
}

export function systemdUnitPath({ scope, home }) {
  return scope === 'system' ? `/etc/systemd/system/${UNIT}` : path.join(home, '.config/systemd/user', UNIT);
}

export function systemdUnit({ scope, root, execPath, envPath, home }) {
  return `[Unit]
Description=Agent connector
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${execPath} ${path.join(root, 'bridge.mjs')}
Environment=PATH=${envPath}
Environment=HOME=${home}
Restart=always
RestartSec=${RESTART_DELAY_MS / 1000}
KillSignal=SIGTERM
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=${scope === 'system' ? 'multi-user.target' : 'default.target'}
`;
}

export const launchdPlistPath = home => path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A LaunchAgent that starts at login, restarts the bridge after it exits, and logs to runtime/.
export function launchdPlist({ root, execPath, envPath, home, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(execPath)}</string>
    <string>${xml(path.join(root, 'bridge.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(envPath)}</string>
    <key>HOME</key><string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>${RESTART_DELAY_MS / 1000}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

// launchctl arguments for each command, addressed through the user's GUI domain.
export function launchctlArgs(action, { uid, plistPath }) {
  const domain = `gui/${uid}`, target = `${domain}/${LABEL}`;
  return {
    load: ['bootstrap', domain, plistPath],
    unload: ['bootout', target],
    restart: ['kickstart', '-k', target],
    status: ['print', target],
  }[action];
}
