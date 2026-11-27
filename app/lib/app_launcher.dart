import 'package:flutter/services.dart';

/// Opens the app under test by package name (Android only; see MainActivity.kt).
class AppLauncher {
  static const _ch = MethodChannel('mutual_testing/apps');
  static Future<bool> isInstalled(String pkg) async => await _ch.invokeMethod<bool>('isInstalled', {'package': pkg}) ?? false;
  static Future<bool> launch(String pkg) async => await _ch.invokeMethod<bool>('launch', {'package': pkg}) ?? false;
}
