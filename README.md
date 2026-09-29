# GF UTM Attribution

A WordPress plugin that records the visitor's UTM campaign (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`) on every Gravity Forms submission, for every form. No settings.

## What it records and where it shows up

The five values are saved as Gravity Forms entry meta (labelled "UTM Source", "UTM Medium", and so on), so they appear wherever Gravity Forms shows entry meta:

- **Entries list columns**: add them with the column picker. They are not shown by default.
- **Entry filters**: filter the entries list with *is*, *is not* or *contains*.
- **CSV export**: listed alongside the form fields in Forms → Import/Export. Values starting with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'` so spreadsheets don't run them as formulas (Gravity Forms itself only guards `=`).
- **Add-on feed field mapping**: any add-on field map that isn't restricted to a field type offers them (`GFAddOn::get_field_map_choices`).

Code can read the keys and labels from `GfUtmAttribution\utm_entry_meta_labels()`, and the values with `gform_get_meta($entry_id, 'utm_source')`.

## Attribution model

First touch per browser session. A small inline script in `<head>` stores the UTM parameters from the first tagged page in a session cookie called `gf_utm_attribution` (no expiry, `path=/`, `SameSite=Lax`, `Secure` on https). Later pages, tagged or not, never overwrite it. Values are trimmed and capped at 200 characters. A submission without the cookie stores empty values, and editing an entry keeps its original attribution.

Submissions (form posts, AJAX, `GFAPI::submit_form`, REST `/submissions`) use the submitting request's cookie. Entries inserted directly (`GFAPI::add_entry`, the REST entries endpoint) aren't attributed.

The script is only printed when Gravity Forms is active.

## Merge tags

`{entry:utm_source}`, `{entry:utm_medium}`, `{entry:utm_campaign}`, `{entry:utm_term}` and `{entry:utm_content}` work in notifications and confirmations. Gravity Forms resolves `{entry:*}` from entry meta by itself. The plugin just lists these tags under "Custom" in the merge tag dropdown.

## Local development

```sh
ddev start
```

WordPress runs at https://gf-utm-attribution.ddev.site (admin / admin), with `plugin/` mounted as the plugin. Gravity Forms is commercial, so it installs automatically only when `GF_LICENSE_KEY=...` is set in `.ddev/.env`, which is gitignored. Outgoing mail goes to Mailpit (`ddev mailpit`).

## Tests

```sh
npm run test:unit   # node + php only: runs the real capture script and plugin PHP against WordPress stubs
npm install && npx playwright install chromium --no-shell
npm run test:e2e    # real browser against the ddev site; needs ddev running with Gravity Forms active
npm test            # both
```

The e2e test runs twice, once with the form embedded with `ajax="false"` and once with `ajax="true"`, each in a fresh browser context. Each run creates its own form, page and entry, checks the entry meta and the notification email in Mailpit, and then deletes all of them. A separate check runs Gravity Forms' real CSV export line builder against formula-like UTM values.

CI (`.github/workflows/ci.yml`) lints the PHP and runs the unit tests on every push to `master` and every pull request. The e2e test needs ddev and a Gravity Forms license, so it only runs locally.

## Releasing

1. Bump `Version:` in `plugin/plugin.php` and commit.
2. Tag and push with a plain semver tag matching that header (no `v` prefix): `git tag X.Y.Z && git push origin X.Y.Z`.

For an `X.Y.Z` tag, CI runs the same lint and unit tests, then builds `dist/gf-utm-attribution.zip` with `bin/build-release.sh` and publishes a GitHub release with that zip attached. The build fails if the tag doesn't match the `Version:` header. To build locally, run `bin/build-release.sh X.Y.Z` with the current header version.
