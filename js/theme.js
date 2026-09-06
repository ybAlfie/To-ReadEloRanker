// Theme handling.
//
// Loaded synchronously in <head>, before anything renders. Setting data-theme
// after first paint gives a flash of the light theme on every page load.

(function () {
    var STORAGE_KEY = 'theme';

    function storedTheme() {
        try {
            var value = localStorage.getItem(STORAGE_KEY);
            return (value === 'dark' || value === 'light') ? value : null;
        } catch (error) {
            return null;   // private mode, or site data blocked
        }
    }

    function systemPrefersDark() {
        return typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
    }

    // Runs while <head> is still parsing, so the first paint is already correct.
    apply(storedTheme() || (systemPrefersDark() ? 'dark' : 'light'));

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function updateToggle() {
        var button = document.querySelector('.theme-toggle');
        if (!button) return;
        var isDark = currentTheme() === 'dark';
        button.textContent = isDark ? '☀ Light' : '☾ Dark';
        button.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
        button.setAttribute('aria-pressed', isDark ? 'true' : 'false');
    }

    window.setTheme = function (theme) {
        apply(theme);
        try {
            localStorage.setItem(STORAGE_KEY, theme);
        } catch (error) {
            // Not fatal, the theme still applies for this page view.
        }
        updateToggle();
    };

    window.toggleTheme = function () {
        window.setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    };

    document.addEventListener('DOMContentLoaded', function () {
        var button = document.querySelector('.theme-toggle');
        if (button) button.addEventListener('click', window.toggleTheme);
        updateToggle();
    });

    // Follow the operating system, but only until the reader chooses for
    // themselves.
    if (typeof window.matchMedia === 'function') {
        var query = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function (event) {
            if (storedTheme()) return;
            apply(event.matches ? 'dark' : 'light');
            updateToggle();
        };
        if (query.addEventListener) query.addEventListener('change', onChange);
        else if (query.addListener) query.addListener(onChange);
    }
})();
