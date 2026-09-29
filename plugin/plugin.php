<?php
/**
 * Plugin Name: GF UTM Attribution
 * Description: Records UTM campaign attribution on every Gravity Forms entry.
 * Version: 1.0.0
 * Author: Joseph Roberts
 * License: GPL-2.0-or-later
 **/

namespace GfUtmAttribution;

if (! defined('ABSPATH')) {
    exit;
}

const UTM_SESSION_COOKIE = 'gf_utm_attribution';

add_action('wp_head', function () {
    // Checked here rather than at load time because Gravity Forms loads after this plugin.
    if (!class_exists('GFForms')) {
        return;
    }

    wp_print_inline_script_tag(
        file_get_contents(plugin_dir_path(__FILE__) . 'utm-capture.js'),
        ['id' => 'gf-utm-attribution-capture']
    );
}, 0);

function get_utm_session_attribution(): array
{
    $cookie = $_COOKIE[UTM_SESSION_COOKIE] ?? null;
    if (!is_string($cookie) || $cookie === '') {
        return [];
    }

    $campaign = json_decode(wp_unslash($cookie), true);

    if (!is_array($campaign)) {
        return [];
    }

    $attribution = [];
    foreach (array_keys(utm_entry_meta_labels()) as $parameter) {
        if (!isset($campaign[$parameter]) || !is_string($campaign[$parameter])) {
            continue;
        }

        preg_match('/\A.{0,200}/us', sanitize_text_field($campaign[$parameter]), $matches);
        $attribution[$parameter] = $matches[0] ?? '';
    }

    return $attribution;
}

function utm_entry_meta_labels(): array
{
    return [
        'utm_source'   => 'UTM Source',
        'utm_medium'   => 'UTM Medium',
        'utm_campaign' => 'UTM Campaign',
        'utm_term'     => 'UTM Term',
        'utm_content'  => 'UTM Content',
    ];
}

function capture_utm_entry_meta($key, $entry, $form)
{
    // Gravity Forms calls this on entry edits as well as initial submissions.
    if (array_key_exists($key, $entry)) {
        return $entry[$key];
    }

    $attribution = get_utm_session_attribution();

    return $attribution[$key] ?? '';
}

add_filter('gform_entry_meta', function ($entry_meta, $form_id) {
    foreach (utm_entry_meta_labels() as $key => $label) {
        $entry_meta[$key] = [
            'label'                      => $label,
            'is_numeric'                 => false,
            'is_default_column'          => false,
            'update_entry_meta_callback' => __NAMESPACE__ . '\\capture_utm_entry_meta',
            'filter'                     => [
                'key'       => $key,
                'text'      => $label,
                'operators' => ['is', 'isnot', 'contains'],
            ],
        ];
    }

    return $entry_meta;
}, 10, 2);

// Gravity Forms already replaces {entry:utm_source} from entry meta; this only lists the tags in the merge tag picker.
add_filter('gform_custom_merge_tags', function ($merge_tags, $form_id, $fields, $element_id) {
    foreach (utm_entry_meta_labels() as $key => $label) {
        $merge_tags[] = ['tag' => '{entry:' . $key . '}', 'label' => $label];
    }

    return $merge_tags;
}, 10, 4);
