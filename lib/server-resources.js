import { readFileSync } from 'node:fs';
import { totalmem, freemem, loadavg, availableParallelism } from 'node:os';

// Host-level capacity, not a promise about how many heavy pages will fit.
export function readServerResources() {
  let totalMiB = totalmem() / 1048576, availableMiB = freemem() / 1048576, swapUsedMiB = null;
  if (process.platform === 'linux') {
    try {
      const data = readFileSync('/proc/meminfo', 'utf8');
      const value = key => Number(data.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]) / 1024;
      const total = value('MemTotal'), available = value('MemAvailable');
      if (Number.isFinite(total)) totalMiB = total;
      if (Number.isFinite(available)) availableMiB = available;
      const swap = value('SwapTotal') - value('SwapFree');
      if (Number.isFinite(swap)) swapUsedMiB = Math.max(0, Math.round(swap));
    } catch { /* OS totals remain useful if procfs is unavailable. */ }
  }
  return {
    mode: process.env.REGION_LAB_RESOURCE_MODE === 'lean' ? 'lean' : 'standard',
    memory: {totalMiB:Math.round(totalMiB), availableMiB:Math.round(Math.min(totalMiB,availableMiB)), swapUsedMiB},
    load1: Math.round(loadavg()[0] * 100) / 100,
    cpuCount: availableParallelism(),
  };
}
