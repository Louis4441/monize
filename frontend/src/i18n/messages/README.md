# Frontend translations

This folder holds per-locale UI strings for Monize. Each locale lives in its own
folder and is split into small JSON files (namespaces) so translation work can
be done in focused PRs.

## Adding a language (example: Spanish)

1. Copy `en/` to a new folder named for the language. Use the ISO 639-1 code
   (`es`) or a BCP 47 tag if you need a regional variant (`pt-BR`).

       cp -r en es

2. Translate every value in every JSON file. **Leave the keys alone.** If a key
   contains an ICU placeholder like `{count, plural, ...}`, preserve the
   structure but translate the surrounding text:

       "transactionCount": "{count, plural, one {# transaccion} other {# transacciones}}"

3. Add one entry to `frontend/src/i18n/config.ts`:

       { code: "es", label: "Espanol", dir: "ltr" }

4. Mirror the same steps in `backend/src/i18n/locales/` so server-rendered
   strings (error messages, email templates) are translated too.

5. Open a PR. No other code changes are needed.

## Testing locally

- Change the language in **Settings -> Preferences**.
- The pseudo-locale `xx` (visible in dev builds only) wraps every translated
  string with `[XX-...-XX]` markers, making it easy to spot strings that
  haven't been extracted yet.

## The pseudo-locale is generated -- do not hand-edit it

The `xx/` catalogs are generated from `en/` by a script. After editing any
`en/*.json` file, regenerate them:

    npm run i18n:pseudo

`npm run i18n:check` fails if `xx/` is out of date, so wire it into CI/pre-commit
to keep the two in sync. ICU placeholders (`{count}`, plural/select blocks) are
preserved; only the surrounding literal text is marked.

## Extracting strings in a component

Client components read strings through next-intl's `useTranslations`:

    'use client';
    import { useTranslations } from 'next-intl';

    export function MyComponent() {
      const t = useTranslations('auth');           // namespace
      return <button>{t('signIn.submit')}</button>; // -> "Sign in"
    }

For strings that embed markup (a link, a `<span>`), use `t.rich` with element
chunks instead of concatenating:

    t.rich('register.agreement', {
      terms: (chunks) => <a href="/terms">{chunks}</a>,
    });

Component tests resolve the real English catalog automatically (`test/render.tsx`
eagerly loads every `en/` namespace), so assertions on visible English text keep
working without mocking next-intl.

## Namespaces

The catalogue is split into small files by feature area. To add a new
namespace, add it to the `NAMESPACES` array in `src/i18n/messages.ts` and
create matching JSON files for every locale.

| Namespace    | Contents                                              |
|--------------|-------------------------------------------------------|
| `common`     | Shared UI primitives (buttons, dialogs, toasts)       |
| `settings`   | The settings page (themes, preferences, language)     |
| `auth`       | Login, register, forgot/reset/change password pages   |
| `navigation` | App header, mobile nav drawer, search, section links  |

More namespaces will be added in subsequent PRs as feature areas are extracted.
