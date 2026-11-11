"use strict";

/**
 * [Input] The prism-agent HachimoDock bridge plugin loopback HTTP/SSE API (the
 * same protocol v2 as DSH; descriptor at ~/.claw-pet/prism-bridge/capability.json).
 * [Output] PrismAdapter reusing the DshAdapter transport under the
 * `prism-agent` identity.
 * [Pos] adapter node in agent-session-bus/src/adapters.
 * [Sync] If the DSH bridge contract changes, update dsh.js and this file.
 */

const path = require("node:path");
const os = require("node:os");

const { DshAdapter } = require("./dsh");

/**
 * PrismAdapter — talks to the `@prism/prism-hachimodock` Cordis plugin over
 * 127.0.0.1 with the same wire contract as DshAdapter. prism-agent is a
 * DeepSeek Harness fork with its own install identity (`~/.prism`), so only
 * the agent id, descriptor path, and diagnostics label differ.
 */
class PrismAdapter extends DshAdapter {
  /**
   * @param {object} [opts]
   * @param {(level: string, msg: string, details?: object) => void} [opts.log]
   * @param {NodeJS.ProcessEnv} [opts.env]   defaults to process.env
   * @param {number} [opts.healthTimeoutMs]  testing seam; defaults to 2000
   * @param {string} [opts.capabilityFile]   descriptor override for tests
   * @param {Function} [opts.acl]            testing seam; replaces the Windows ACL verifier
   */
  constructor({ log, env, healthTimeoutMs, capabilityFile, acl } = {}) {
    const resolvedEnv = env || process.env;
    super({
      log,
      env: resolvedEnv,
      healthTimeoutMs,
      agentId: "prism-agent",
      label: "Prism",
      capabilityFile: capabilityFile
      || resolvedEnv.HACHIMODOCK_PRISM_CAPABILITY_FILE
        || path.join(os.homedir(), ".claw-pet", "prism-bridge", "capability.json"),
      acl,
    });
  }
}

module.exports = { PrismAdapter };
