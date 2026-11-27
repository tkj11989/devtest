package com.mutualtesting.mutual_testing

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Opens the app under test by its package name, for the daily 30-second test.
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "mutual_testing/apps").setMethodCallHandler { call, result ->
            val pkg = call.argument<String>("package")
            when (call.method) {
                "isInstalled" -> result.success(pkg != null && packageManager.getLaunchIntentForPackage(pkg) != null)
                "launch" -> {
                    val intent = pkg?.let { packageManager.getLaunchIntentForPackage(it) }
                    if (intent == null) {
                        result.success(false)
                    } else {
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(intent)
                        result.success(true)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }
}
