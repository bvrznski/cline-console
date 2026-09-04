import assert from "node:assert/strict";
import test from "node:test";
import { userServiceUnit } from "../src/service/systemd";

test("user service is a private journal-backed restartable daemon", () => {
  const unit = userServiceUnit("/path with space/cline-console");
  assert.match(unit, /^\[Unit\]/);
  assert.match(unit, /ExecStart=\/path\\x20with\\x20space\/cline-console service run/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /TimeoutStopSec=10/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /StandardOutput=journal/);
  assert.match(unit, /StandardError=journal/);
  assert.match(unit, /WantedBy=default.target/);
});
