import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/download-tools.ps1", "utf8");

test("Windows restore script reads the production manifest", () => {
  assert.match(
    script,
    /Get-Content\s+-Raw\s+-LiteralPath\s+\$ManifestPath\s+\|\s+ConvertFrom-Json/,
  );
  assert.match(script, /Where-Object\s+\{\s*\$_.target\s+-eq\s+'win-x64'\s*\}/);
  assert.doesNotMatch(script, /releases\/download\/2026\.07\.04\/yt-dlp\.exe/);
  assert.doesNotMatch(script, /autobuild-2026-06-22-18-32/);
  assert.doesNotMatch(script, /https:\/\//);
});

test("Windows restore script groups archives and always removes its temporary root", () => {
  assert.match(script, /Group-Object\s+-Property\s+sourceUrl/);
  assert.match(script, /try\s*\{/);
  assert.match(script, /finally\s*\{/);
  assert.match(
    script,
    /Remove-Item\s+-Recurse\s+-Force\s+-ErrorAction\s+SilentlyContinue\s+\$TempRoot/,
  );
  assert.match(script, /Assert-Hash\s+\$destination\s+\$tool.sha256/);
});
