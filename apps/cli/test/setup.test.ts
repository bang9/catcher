import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runSetup } from '../src/setup.ts';

test('claude-code setup writes the skill and merges hooks once, keeping existing settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catcher-setup-'));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }),
    );
    runSetup('claude-code', 'work', false);
    runSetup('claude-code', 'work', false);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'catcher inbox --hook --profile work');
    const skill = readFileSync(join(dir, 'skills', 'catcher', 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: catcher\n/);
    assert.match(skill, /catcher ask --profile work/);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex setup replaces its own block instead of appending twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catcher-setup-'));
  process.env.CODEX_HOME = dir;
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '# my rules\n');
    runSetup('codex', 'default', false);
    runSetup('codex', 'default', false);
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    assert.ok(text.startsWith('# my rules'));
    assert.equal(text.split('<!-- catcher:start -->').length, 2);
  } finally {
    delete process.env.CODEX_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
