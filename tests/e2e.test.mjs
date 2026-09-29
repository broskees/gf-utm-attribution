import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chromium, request} from 'playwright';

// Real browser against the ddev site: landing UTMs -> cookie -> Gravity Forms entry meta -> notification email.
// Runs once with a non-AJAX form embed and once with an AJAX one, after a browserless check of the CSV export.
const campaignQuery = 'utm_source=e2e_source&utm_medium=e2e&utm_campaign=e2e_campaign&utm_term=estate%20planning&utm_content=0';
const expectedAttribution = {
  utm_source: 'e2e_source',
  utm_medium: 'e2e',
  utm_campaign: 'e2e_campaign',
  utm_term: 'estate planning',
  utm_content: '0',
};
const runStartedAt = Date.now();

function runDdev(args) {
  return execFileSync('ddev', args, {encoding: 'utf8'});
}

function wpEval(php) {
  const output = runDdev(['wp', 'eval', php]).trim();
  return output ? JSON.parse(output) : null;
}

let ddevProject;
try {
  ddevProject = JSON.parse(runDdev(['describe', '-j'])).raw;
} catch (error) {
  throw new Error(`Could not describe the ddev project. Is ddev installed and is this the plugin repo?\n${error.message}`);
}
if (ddevProject.status !== 'running') {
  throw new Error(`The ddev project is "${ddevProject.status}", not running. Run \`ddev start\` first.`);
}

const site = wpEval(`echo json_encode([
  'gravity_forms_active' => class_exists('GFAPI'),
  'plugin_active'        => is_plugin_active('gf-utm-attribution/plugin.php'),
  'home_url'             => home_url('/'),
]);`);
if (!site.gravity_forms_active) {
  throw new Error('Gravity Forms is not active on the ddev site. Put GF_LICENSE_KEY in .ddev/.env and run `ddev restart`.');
}
if (!site.plugin_active) {
  throw new Error('GF UTM Attribution is not active on the ddev site. Run `ddev wp plugin activate gf-utm-attribution`.');
}

// Every check runs, so one failure does not hide the results of the others.
let failedChecks = 0;

// Runs Gravity Forms' real CSV export line builder, as Forms -> Import/Export does, on hostile stored UTM values.
function assertCsvExportNeutralisesFormulas() {
  const runToken = `gf-utm-e2e-${runStartedAt}-export`;
  const storedAttribution = {
    utm_source: '=1+1',
    utm_medium: '+1+1',
    utm_campaign: '-1+1',
    utm_term: '@SUM(1)',
    utm_content: 'newsletter',
  };
  let formId;

  try {
    formId = wpEval(`
      $form_id = GFAPI::add_form([
        'title'  => '${runToken}',
        'fields' => [['type' => 'text', 'id' => 1, 'label' => 'Name']],
      ]);
      if (is_wp_error($form_id)) {
        WP_CLI::error($form_id->get_error_message());
      }
      echo json_encode($form_id);
    `);

    const exported = wpEval(`
      require_once GFCommon::get_base_path() . '/export.php';
      $entry_id = GFAPI::add_entry(array_merge(['form_id' => ${formId}], json_decode('${JSON.stringify(storedAttribution)}', true)));
      if (is_wp_error($entry_id)) {
        WP_CLI::error($entry_id->get_error_message());
      }
      $form = GFExport::add_default_export_fields(GFAPI::get_form(${formId}));
      $fields = array_keys(GfUtmAttribution\\utm_entry_meta_labels());
      $line = GFExport::get_entry_export_line(GFAPI::get_entry($entry_id), $form, $fields, GFExport::get_field_row_count($form, $fields, 1), ',');
      $stored = [];
      foreach ($fields as $key) {
        $stored[$key] = gform_get_meta($entry_id, $key);
      }
      echo json_encode(['line' => $line, 'stored' => $stored]);
    `);
    assert.equal(exported.line, `"'=1+1","'+1+1","'-1+1","'@SUM(1)","newsletter"`, 'CSV export must start formula-like UTM values with exactly one apostrophe');
    assert.deepEqual(exported.stored, storedAttribution, 'Exporting must not change the stored UTM values');
  } finally {
    // Deleting the form also deletes its entries.
    if (formId) wpEval(`GFAPI::delete_form(${formId});`);
  }
}

try {
  assertCsvExportNeutralisesFormulas();
  console.log('PASS CSV export: formula-like UTM values get one leading apostrophe, others are unchanged');
} catch (error) {
  failedChecks++;
  console.error('FAIL CSV export:', error);
}

const mailpit = await request.newContext({baseURL: ddevProject.mailpit_https_url, ignoreHTTPSErrors: true});
const browser = await chromium.launch({channel: 'chromium'});

// Each embed gets its own form, page, notification subject and fresh browser context, and deletes them when done.
async function assertFirstTouchReachesEntryAndEmail(ajax) {
  const runToken = `gf-utm-e2e-${runStartedAt}-${ajax ? 'ajax' : 'no-ajax'}`;
  const notificationSearch = {query: `subject:"${runToken}"`};
  let formId;
  let pageId;
  let context;

  try {
    formId = wpEval(`
      $form_id = GFAPI::add_form([
        'title'         => '${runToken}',
        'fields'        => [['type' => 'text', 'id' => 1, 'label' => 'Name']],
        'notifications' => [
          'utm-e2e' => [
            'id'       => 'utm-e2e',
            'name'     => 'UTM e2e',
            'isActive' => true,
            'event'    => 'form_submission',
            'toType'   => 'email',
            'to'       => get_option('admin_email'),
            'subject'  => '${runToken}',
            'message'  => 'Source: {entry:utm_source} Campaign: {entry:utm_campaign}',
          ],
        ],
      ]);
      if (is_wp_error($form_id)) {
        WP_CLI::error($form_id->get_error_message());
      }
      echo json_encode($form_id);
    `);

    const formPage = wpEval(`
      $page_id = wp_insert_post([
        'post_type'    => 'page',
        'post_status'  => 'publish',
        'post_title'   => '${runToken}',
        'post_content' => '[gravityform id="${formId}" title="false" ajax="${ajax}"]',
      ], true);
      if (is_wp_error($page_id)) {
        WP_CLI::error($page_id->get_error_message());
      }
      echo json_encode(['id' => $page_id, 'url' => get_permalink($page_id)]);
    `);
    pageId = formPage.id;

    context = await browser.newContext({ignoreHTTPSErrors: true});
    const page = await context.newPage();

    await page.goto(`${site.home_url}?${campaignQuery}`);
    const landingCookies = await context.cookies();
    assert(landingCookies.some(cookie => cookie.name === 'gf_utm_attribution'), 'Landing page did not set the gf_utm_attribution cookie');

    const retaggedFormUrl = new URL(formPage.url);
    retaggedFormUrl.searchParams.set('utm_source', 'later_source');
    retaggedFormUrl.searchParams.set('utm_campaign', 'later_campaign');
    await page.goto(retaggedFormUrl.href);

    await page.goto(formPage.url);
    // Gravity Forms 3.1.2 AJAX forms post into a hidden iframe, then swap #gform_wrapper_N in the page
    // for the confirmation, so the same confirmation selector works for both embeds.
    const form = page.locator(`#gform_${formId}`);
    assert.equal(await form.getAttribute('target'), ajax ? `gform_ajax_frame_${formId}` : null, `ajax="${ajax}" embed rendered the wrong submission mode`);
    await form.locator('input[name="input_1"]').fill('E2E Visitor');
    await page.locator(`#gform_submit_button_${formId}`).click();
    await page.locator(`#gform_confirmation_message_${formId}`).waitFor();

    const stored = wpEval(`
      $entries = GFAPI::get_entries(${formId});
      $entry = GFAPI::get_entry($entries[0]['id']);
      $result = ['entry_count' => count($entries), 'entry' => [], 'meta' => []];
      foreach (array_keys(GfUtmAttribution\\utm_entry_meta_labels()) as $key) {
        $result['entry'][$key] = $entry[$key] ?? null;
        $result['meta'][$key] = gform_get_meta($entry['id'], $key);
      }
      echo json_encode($result);
    `);
    assert.equal(stored.entry_count, 1, 'Expected exactly one entry from the e2e submission');
    assert.deepEqual(stored.entry, expectedAttribution, 'GFAPI::get_entry does not carry the first-touch campaign');
    assert.deepEqual(stored.meta, expectedAttribution, 'gform_get_meta does not hold the first-touch campaign');

    let notifications = [];
    for (let attempt = 0; attempt < 20 && !notifications.length; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 500));
      notifications = (await (await mailpit.get('/api/v1/search', {params: notificationSearch})).json()).messages;
    }
    assert.equal(notifications.length, 1, `Expected one notification in Mailpit with subject ${runToken}`);
    const notification = await (await mailpit.get(`/api/v1/message/${notifications[0].ID}`)).json();
    assert(notification.HTML.includes('Source: e2e_source'), `Notification is missing {entry:utm_source}:\n${notification.HTML}`);
    assert(notification.HTML.includes('Campaign: e2e_campaign'), `Notification is missing {entry:utm_campaign}:\n${notification.HTML}`);
  } finally {
    await context?.close();
    // Deleting the form also deletes its entries.
    if (formId) wpEval(`GFAPI::delete_form(${formId});`);
    if (pageId) wpEval(`wp_delete_post(${pageId}, true);`);
    await mailpit.delete('/api/v1/search', {params: notificationSearch});
  }
}

try {
  for (const ajax of [false, true]) {
    try {
      await assertFirstTouchReachesEntryAndEmail(ajax);
      console.log(`PASS ajax="${ajax}": first-touch campaign reaches the entry meta and the notification email`);
    } catch (error) {
      failedChecks++;
      console.error(`FAIL ajax="${ajax}":`, error);
    }
  }
} finally {
  await browser.close();
  await mailpit.dispose();
}
if (failedChecks) {
  process.exitCode = 1;
}
