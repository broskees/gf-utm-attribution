<?php

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

// Exercise the plugin hooks without loading WordPress or writing entries.
$hooks = [];
$input = json_decode(stream_get_contents(STDIN), true) ?: [];

define('ABSPATH', __DIR__ . '/');

if ($input['gravity_forms_active'] ?? true) {
    class GFForms {}
}

function add_action($name, $callback, $priority = 10, $arguments = 1)
{
    $GLOBALS['hooks'][$name][$priority][] = $callback;
}

function add_filter($name, $callback, $priority = 10, $arguments = 1)
{
    add_action($name, $callback, $priority, $arguments);
}

function plugin_dir_path($file)
{
    return dirname($file) . '/';
}

function wp_print_inline_script_tag($data, $attributes = [])
{
    echo '<script>' . $data . '</script>';
}

function wp_unslash($value)
{
    return is_array($value) ? array_map('wp_unslash', $value) : stripslashes($value);
}

function sanitize_text_field($value)
{
    return trim(strip_tags($value));
}

require dirname(__DIR__) . '/plugin/plugin.php';

// PHP decodes cookie values; WordPress then applies magic quotes.
$cookie = $input['cookie'] ?? null;
$_COOKIE[GfUtmAttribution\UTM_SESSION_COOKIE] = is_string($cookie)
    ? addslashes(rawurldecode($cookie))
    : $cookie;

ob_start();
$head_hooks = $hooks['wp_head'] ?? [];
ksort($head_hooks);
foreach ($head_hooks as $callbacks) {
    foreach ($callbacks as $callback) {
        $callback();
    }
}
$head = ob_get_clean();

$meta = [];
foreach ($hooks['gform_entry_meta'][10] as $callback) {
    $meta = $callback($meta, 4);
}
$entry = $input['entry'] ?? ['id' => 123];
$values = [];
foreach ($meta as $key => $definition) {
    $values[$key] = call_user_func($definition['update_entry_meta_callback'], $key, $entry, ['id' => 4]);
}

$merge_tags = [];
foreach ($hooks['gform_custom_merge_tags'][10] ?? [] as $callback) {
    $merge_tags = $callback($merge_tags, 4, [], 'field_notification_message');
}

echo json_encode(['head' => $head, 'values' => $values, 'merge_tags' => $merge_tags], JSON_THROW_ON_ERROR);
