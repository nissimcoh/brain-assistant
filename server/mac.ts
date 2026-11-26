import { hostname, freemem, totalmem, uptime, homedir } from 'node:os';
import { statfs } from 'node:fs/promises';
import type { Exec } from './tools.ts';

export async function machineMetrics(exec: Exec) {
  const battery = exec('pmset', ['-g', 'batt']).then(({ stdout }) => {
    const match = stdout.match(/(\d+)%/);
    return match ? { percent: Number(match[1]), plugged: /AC Power/.test(stdout),
      status: /discharging/.test(stdout) ? 'מתרוקן' : /charged/.test(stdout) ? 'טעון' : /charging/.test(stdout) ? 'נטען' : '' } : null;
  }).catch(() => null);
  const disk = statfs(homedir()).then(s => ({ free: s.bavail * s.bsize, total: s.blocks * s.bsize })).catch(() => null);
  const name = exec('/usr/sbin/scutil', ['--get', 'ComputerName']).then(r => r.stdout.trim() || hostname()).catch(() => hostname());
  let uptimeSeconds: number | null = null;
  try { uptimeSeconds = uptime(); } catch { /* Some service contexts restrict uptime. */ }
  const [displayName, batteryInfo, diskInfo] = await Promise.all([name, battery, disk]);
  return { name: displayName, battery: batteryInfo, disk: diskInfo, ram: { free: freemem(), total: totalmem() }, uptimeSeconds, sampledAt: Date.now() };
}

export interface RunningApp { name: string; bundle: string; pid: number; started: string; canQuit: boolean }

// AppKit enumerates regular GUI apps in this login session. The action resolves
// the same launch instance again. Arguments are data and never become script.
const appKit = `
ObjC.import('AppKit');
function run(args) {
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  const result = [];
  const protectedApps = ['com.apple.finder','com.apple.dock','com.apple.loginwindow','com.apple.systempreferences',
    'com.apple.terminal','com.openai.codex','com.openai.chat','com.anthropic.claudefordesktop','com.ollama.ollama','io.tailscale.ipn.macsys'];
  for (let i = 0; i < apps.count; i++) {
    const app = apps.objectAtIndex(i);
    if (Number(app.activationPolicy) !== 0 || app.terminated) continue;
    const bundle = ObjC.unwrap(app.bundleIdentifier);
    const name = ObjC.unwrap(app.localizedName);
    if (!bundle || !name) continue;
    const pid = Number(app.processIdentifier);
    const started = app.launchDate.isNil() ? '' : String(Number(app.launchDate.timeIntervalSince1970));
    const canQuit = !!started && !protectedApps.includes(bundle.toLowerCase()) && !/^(ollama|tailscale|felipe|brain)$/i.test(name);
    if (!args.length) { result.push({name, bundle, pid, started, canQuit}); continue; }
    if (bundle === args[0] && pid === Number(args[1]) && started === args[2] && canQuit)
      return JSON.stringify({requested: Boolean(app.terminate)});
  }
  return JSON.stringify(args.length ? {requested:false} : result);
}`;

export async function runningApps(exec: Exec): Promise<RunningApp[]> {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', appKit]);
  return (JSON.parse(stdout) as RunningApp[]).sort((a, b) => a.name.localeCompare(b.name, 'he'));
}

export async function requestQuit(exec: Exec, bundle: string, pid: number, started: string): Promise<boolean> {
  const { stdout } = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', appKit, '--', bundle, String(pid), started]);
  return JSON.parse(stdout).requested === true;
}
