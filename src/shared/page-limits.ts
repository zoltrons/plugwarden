// Size caps of what a frame reports. On their own: the collector truncates to them in every page, and must
// not pull the validators along. messages.ts refuses anything over them.
export const MAX_FIELDS = 256;
export const MAX_FORMS = 64;
export const MAX_BUTTONS = 64;
export const MAX_DATA_ATTRS = 16;
export const MAX_PAGE_STRING = 300;
export const MAX_FORM_TEXT = 2000;
export const MAX_BLOCK_PATH = 32;
