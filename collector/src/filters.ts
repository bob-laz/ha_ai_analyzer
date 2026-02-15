import type { NormalizedEvent } from './types.js';

export const isAllowed = (event: NormalizedEvent, allowlist: Set<string>, excludelist: Set<string>): boolean => {
  if (event.domain && excludelist.has(event.domain)) {
    return false;
  }

  if (allowlist.size > 0) {
    return event.domain ? allowlist.has(event.domain) : false;
  }

  return true;
};
