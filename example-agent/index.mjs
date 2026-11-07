// Template agent adapter: copy this folder to <name>-agent/, register it in core/registry.mjs and
// replace the echo with real work. It needs no external program, so it also
// serves as `"agent": "example"` for trying a channel without spending model quota.
//
// Contract (details in core/README.md):
//   createAgent(config, { root, runtime, env, log }) -> agent
//   agent.runTurn(request) -> { cancel(), result }
//     result resolves to the final answer (non-empty string), or to null after cancel();
//     it rejects with an Error whose message is sent to the user as is.

export const requiredBins = () => [];

export function createAgent(config, { log }) {
  const sessions = new Map(); // session ID -> number of turns; a real agent keeps this itself

  return {
    id: 'example',
    displayName: 'Example',
    capabilities: { images: false, files: false },

    runTurn({ sessionId, cwd, text, timeoutMs, onSession }) {
      let timer, settle;
      const result = new Promise((resolve, reject) => {
        settle = { resolve, reject };
        // 1. Continue the given session, or start one on the first turn (sessionId is undefined).
        const id = sessionId || `example-${Date.now()}`;
        // 2. Report the ID as soon as it is known; the hub saves it and passes it back next turn.
        onSession(id);
        // 3. Stop on the turn deadline with a user-facing message.
        timer = setTimeout(() => reject(Object.assign(new Error('任务超时已停止。'), { code: 'timeout' })), timeoutMs);
        // 4. Do the work. text already carries the bridge notes (working directory, reply format).
        const turn = (sessions.get(id) || 0) + 1;
        sessions.set(id, turn);
        const request = text.split('\n\n[桥接')[0];
        log('example_turn', { turn });
        setImmediate(() => { clearTimeout(timer); resolve(`第 ${turn} 轮（${cwd}）：${request}`); });
      });
      return {
        // 5. Cancel stops the work and resolves the result to null.
        cancel() { clearTimeout(timer); settle.resolve(null); },
        result,
      };
    },
  };
}
