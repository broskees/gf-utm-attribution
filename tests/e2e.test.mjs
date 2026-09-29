import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chromium, request} from 'playwright';

// Real browser against the ddev site: landing UTMs -> cookie -> Gravity Forms entry meta -> notification email.
const campaignQuery = 'utm_source=e2e_source&utm_medium=e2e&utm_campaign=e2e_campaign&utm_term=estate%20planning&utm_content=0';
const expectedAttribution = {
  utm_source: 'e2e_source',
  utm_medium: 'e2e',
  utm_campaign: 'e2e_campaign',
  utm_term: 'estate planning',
  utm_content: '0',
};
const runToken = `gf-utm-e2e-${Date.now()}`;

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

const mailpit = await request.newContext({baseURL: ddevProject.mailpit_https_url, ignoreHTTPSErrors: true});
const notificationSearch = {query: `subject:"${runToken}"`};
const browser = await chromium.launch({channel: 'chromium'});
let formId;
let pageId;

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
      'post_content' => '[gravityform id="${formId}" title="false" ajax="false"]',
    ], true);
    if (is_wp_error($page_id)) {
      WP_CLI::error($page_id->get_error_message());
    }
    echo json_encode(['id' => $page_id, 'url' => get_permalink($page_id)]);
  `);
  pageId = formPage.id;

  const context = await browser.newContext({ignoreHTTPSErrors: true});
  const page = await context.newPage();

  await page.goto(`${site.home_url}?${campaignQuery}`);
  const landingCookies = await context.cookies();
  assert(landingCookies.some(cookie => cookie.name === 'gf_utm_attribution'), 'Landing page did not set the gf_utm_attribution cookie');

  const retaggedFormUrl = new URL(formPage.url);
  retaggedFormUrl.searchParams.set('utm_source', 'later_source');
  retaggedFormUrl.searchParams.set('utm_campaign', 'later_campaign');
  await page.goto(retaggedFormUrl.href);

  await page.goto(formPage.url);
  await page.locator(`#gform_${formId} input[name="input_1"]`).fill('E2E Visitor');
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

  console.log('PASS first-touch campaign reaches the entry meta and the notification email');
} finally {
  await browser.close();
  // Deleting the form also deletes its entries.
  if (formId) wpEval(`GFAPI::delete_form(${formId});`);
  if (pageId) wpEval(`wp_delete_post(${pageId}, true);`);
  await mailpit.delete('/api/v1/search', {params: notificationSearch});
  await mailpit.dispose();
}
