// Entry. Polyfills must run before anything imports @catcher/protocol (it builds a TextDecoder at load time
// and @noble needs crypto.getRandomValues), so they are imported first, then the router.
import './src/lib/polyfills';
import 'expo-router/entry';
