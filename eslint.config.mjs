import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([{
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { js },
    extends: ['js/recommended'],

    languageOptions: {
        globals: {
            "Stats": "readonly",
            "realityEditor": "writable",
            "createNameSpace": "writable",
            "globalStates": "writable",
            "objects": "writable",
            "overlayDiv": "writable",
        },

        "ecmaVersion": 2022,
        "sourceType": "module",
        parserOptions: {},
    },

    "rules": {
        "no-shadow": "off",
        "no-useless-escape": "off",
        "no-prototype-builtins": "off",

        "no-redeclare": ["error", {
            "builtinGlobals": false,
        }],

        "no-unused-vars": ["error", {
            "varsIgnorePattern": "^_",
            "argsIgnorePattern": "^_",
            "caughtErrorsIgnorePattern": "^_",
        }],

        "no-inner-declarations": "off",
    },
}, {
    files: ["content_scripts/**/*.js", "tools/**/*.js"],

    languageOptions: {
        globals: {
            ...globals.browser,
        },
    },
}, {
    files: ["interfaces/**/*.js"],

    languageOptions: {
        globals: {
            ...globals.node,
        },
    },
}, globalIgnores(["**/webrtc-adapter.js"])]);
