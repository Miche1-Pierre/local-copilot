// Local hardware detection (GPU VRAM, RAM, CPU) for model recommendations.
// Runs local tools only (nvidia-smi, the Windows registry, sysctl); nothing leaves the machine.

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import type { GpuInfo, HardwareProfile } from '../core/hardware/recommend';

function run(cmd: string, args: string[], timeout = 4000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

function vendorOf(name: string): GpuInfo['vendor'] {
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/i.test(name)) return 'nvidia';
  if (/amd|radeon|ati\b/i.test(name)) return 'amd';
  if (/intel|iris|uhd|arc\b/i.test(name)) return 'intel';
  if (/apple/i.test(name)) return 'apple';
  return 'other';
}

async function nvidiaGpus(): Promise<GpuInfo[]> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, mem] = l.split(',').map((s) => s.trim());
      return { name, vramMB: Number(mem) || 0, vendor: 'nvidia' as const };
    });
}

async function windowsRegistryGpus(): Promise<GpuInfo[]> {
  // Win32_VideoController caps AdapterRAM at 4 GB; the driver's qwMemorySize is exact.
  const script =
    "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.'HardwareInformation.qwMemorySize' } | ForEach-Object { '{0}|{1}' -f $_.DriverDesc, $_.'HardwareInformation.qwMemorySize' }";
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('|'))
    .map((l) => {
      const [name, bytes] = l.split('|');
      return { name, vramMB: Math.round(Number(bytes) / (1024 * 1024)), vendor: vendorOf(name) };
    });
}

/** Current memory of the first NVIDIA GPU (nvidia-smi), or undefined on other hardware. */
export async function nvidiaMemoryMB(): Promise<{ totalMB: number; usedMB: number } | undefined> {
  const out = await run('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'], 3000);
  const first = out?.split('\n').find((l) => l.trim());
  if (!first) return undefined;
  const [total, used] = first.split(',').map((s) => Number(s.trim()));
  return Number.isFinite(total) && Number.isFinite(used) ? { totalMB: total, usedMB: used } : undefined;
}

let cached: Promise<HardwareProfile> | undefined;

export function detectHardware(): Promise<HardwareProfile> {
  cached ??= (async () => {
    const platform = process.platform;
    const cpus = os.cpus();
    const profile: HardwareProfile = {
      gpus: [],
      totalRamMB: Math.round(os.totalmem() / (1024 * 1024)),
      cpuModel: cpus[0]?.model.trim(),
      cpuThreads: cpus.length,
      platform,
      appleSilicon: platform === 'darwin' && process.arch === 'arm64',
    };
    if (profile.appleSilicon) {
      profile.gpus = [{ name: 'Apple GPU (unified memory)', vramMB: profile.totalRamMB, vendor: 'apple' }];
      return profile;
    }
    const nvidia = await nvidiaGpus();
    if (platform === 'win32') {
      const reg = await windowsRegistryGpus();
      profile.gpus = [...nvidia, ...reg.filter((g) => g.vendor !== 'nvidia' || nvidia.length === 0)];
    } else {
      profile.gpus = nvidia;
    }
    return profile;
  })();
  return cached;
}
