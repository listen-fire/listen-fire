import * as z from 'zod';

// External records hand back booleans as strings ('true', '1') or numbers
// (1, 0) as often as as real booleans. Anything that isn't one of those
// recognised spellings parses to null rather than throwing, so a single odd
// field never fails a whole record.
const nullishBoolean = z.preprocess((val) => {
  if (typeof val === 'string') {
    switch (val.trim().toLocaleLowerCase()) {
      case '1':
        return true;
      case '0':
        return false;
      case 'true':
        return true;
      case 'false':
        return false;
      default:
        return false;
    }
  } else if (typeof val === 'number') {
    switch (val) {
      case 1:
        return true;
      case 0:
        return false;
      default:
        return null;
    }
  }
  return val;
}, z.boolean().nullish().catch(null));

export { nullishBoolean };
