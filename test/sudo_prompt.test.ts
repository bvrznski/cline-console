import test from "node:test";
import assert from "node:assert/strict";
import { containsInteractiveSudo } from "../src/extension/sudo_prompt";

test("sudo prompt detector recognizes interactive sudo in command chains", () => {
  assert.equal(containsInteractiveSudo("sudo apt install package"), true);
  assert.equal(containsInteractiveSudo("cd /repo && sudo make install"), true);
  assert.equal(containsInteractiveSudo("printf ok; /usr/bin/sudo systemctl restart demo"), true);
});

test("sudo prompt detector ignores non-interactive and unrelated commands", () => {
  assert.equal(containsInteractiveSudo("sudo -n true"), false);
  assert.equal(containsInteractiveSudo("sudo --non-interactive systemctl status demo"), false);
  assert.equal(containsInteractiveSudo("printf 'sudo apt install'"), false);
  assert.equal(containsInteractiveSudo("echo pseudoutil"), false);
});
