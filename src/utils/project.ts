import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { resolve, normalize } from 'path';
import { logger } from './logger';

/**
 * Validate that appPath points to a real, non-system directory.
 * Blocks path traversal, UNC paths, and common system directories.
 */
function isValidAppPath(appPath: string): boolean {
  const normalized = normalize(resolve(appPath));
  const lower = normalized.toLowerCase();

  // Block path traversal
  if (normalized.includes('..')) return false;

  // Block UNC paths on Windows
  if (normalized.startsWith('\\\\')) return false;

  // Block system directories
  const blocked = [
    '/etc', '/sys', '/proc', '/dev', '/bin', '/sbin', '/usr/bin',
    'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
  ];
  if (blocked.some((b) => lower.startsWith(b))) return false;

  // Must be an existing directory
  return existsSync(normalized);
}

// Helper function to check if Electron is installed (global or local)
export async function isElectronInstalled(appPath?: string): Promise<boolean> {
  try {
    const execAsync = promisify(exec);

    if (appPath) {
      if (!isValidAppPath(appPath)) {
        logger.warn(`Invalid appPath rejected: ${appPath}`);
        return false;
      }

      // Check for local Electron installation in the project
      try {
        await execAsync('npm list electron', { cwd: appPath });
        return true;
      } catch {
        // If local check fails, try global
        logger.warn('Local Electron not found, checking global installation');
      }
    }

    // Check for global Electron installation
    await execAsync('electron --version');
    return true;
  } catch (error) {
    logger.error('Electron not found:', error);
    return false;
  }
}
