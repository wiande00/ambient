import { en, type Strings } from "./en";

/**
 * Deliberately thin. Swedish (`sv`) drops in here as a second catalogue with no call-site
 * changes. Nothing in the app reads a literal string.
 */
const catalogues = { en } satisfies Record<string, Strings>;

export type Locale = keyof typeof catalogues;

export const DEFAULT_LOCALE: Locale = "en";

export function getStrings(locale: Locale = DEFAULT_LOCALE): Strings {
  return catalogues[locale];
}

/**
 * The BCP 47 tag each catalogue formats dates and numbers with. Separate from the catalogue
 * key because `"en"` is not a format: passing it — or passing `undefined` and inheriting
 * whatever the browser is set to — renders "Monday, August 10" on one machine and
 * "Monday 10 August" on the next. Ambient is en-GB, and Swedish will be `sv: "sv-SE"` here.
 */
const LOCALE_TAGS: Record<Locale, string> = { en: "en-GB" };

export function localeTag(locale: Locale = DEFAULT_LOCALE): string {
  return LOCALE_TAGS[locale];
}

/** `interpolate("{done} of {total}", { done: 1, total: 3 })` → `"1 of 3"`. */
export function interpolate(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
