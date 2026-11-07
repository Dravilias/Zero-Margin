import '@fontsource/big-shoulders-display/700';
import '@fontsource/big-shoulders-display/800';
import '@fontsource/big-shoulders-display/900';
import '@fontsource/barlow-condensed/400';
import '@fontsource/barlow-condensed/500';
import '@fontsource/barlow-condensed/600';
import '@fontsource/barlow-condensed/700';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/700.css';
import './style.css';
import { afterPaint } from './ui/dom';
import { initScreens } from './ui/screens';
import { loadSettings } from './ui/settings';

loadSettings();
// Lets the boot screen in index.html show first, because building the menu's skyline takes a moment.
afterPaint(() => initScreens(document.getElementById('app')!));
