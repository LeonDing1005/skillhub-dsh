/** Portable relative-path rules shared by remote manifests and ZIP entries. */

import { posix, win32 } from 'node:path'

const WINDOWS_FORBIDDEN = /[\u0000-\u001f<>:"|?*]/
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i

/**
 * Determine whether a path can be represented as the same regular file on supported hosts.
 * @param path - candidate root-relative POSIX file or directory path without a trailing slash.
 * @returns whether every segment is portable and traversal-free.
 */
export function isSafeManagedPath(path: string): boolean {
  return path !== '' && !path.includes('\\') && !posix.isAbsolute(path) && !win32.isAbsolute(path)
    && !/^[A-Za-z]:/.test(path) && path.split('/').every(isSafeSegment)
}

function isSafeSegment(segment: string): boolean {
  return segment !== '' && segment !== '.' && segment !== '..'
    && !WINDOWS_FORBIDDEN.test(segment) && !/[. ]$/.test(segment) && !WINDOWS_DEVICE.test(segment)
}
