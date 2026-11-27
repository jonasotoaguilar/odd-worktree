'use strict';
// The host object the vendored bridge factory receives (native-bridge, invariant 32).
//
// The vendored bridge registers `/bridge-status` from its factory, eagerly. A user who
// still has the standalone gentle-shell-bridge installed — it was this package's own
// prerequisite until now — would then have the name registered TWICE, and Pi stops
// resolving `/bridge-status` at all. So the bridge never gets the real `pi`: it gets
// this view of it, which differs in exactly one thing — the registration of that one
// command is held until the first `session_start`, when every extension is loaded and
// the host's own command list says whether another copy already owns the name. The
// first copy to find the name taken stays quiet; a lone copy registers it, once.
//
// Everything else — `on`, `events`, `getCommands`, every other registration — is the
// real `pi`'s, unchanged. The vendored sources are never edited for this.

const STATUS_COMMAND = 'bridge-status';

function ownsCommand(pi, name) {
  try {
    const commands = typeof pi.getCommands === 'function' ? pi.getCommands() : [];
    return Array.isArray(commands) && commands.some((command) => command && command.name === name);
  } catch {
    // A host that cannot list its commands cannot prove another copy owns the name.
    return false;
  }
}

function bridgeHost(pi) {
  let held = null;
  let settled = false;

  const settle = () => {
    if (settled || held === null) return;
    settled = true;
    if (ownsCommand(pi, STATUS_COMMAND)) return;
    try {
      pi.registerCommand(STATUS_COMMAND, held);
    } catch {
      // A host that refuses the registration keeps everything else the bridge does.
    }
  };

  return new Proxy(pi, {
    get(target, property) {
      if (property === 'registerCommand') {
        return (name, definition) => {
          if (name !== STATUS_COMMAND) return target.registerCommand(name, definition);
          held = definition;
          if (typeof target.on === 'function') target.on('session_start', settle);
          return undefined;
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = { bridgeHost, STATUS_COMMAND };
