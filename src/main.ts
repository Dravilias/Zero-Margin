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
import { initScreens } from './ui/screens';
import { loadSettings } from './ui/settings';

loadSettings();
initScreens(document.getElementById('app')!);
