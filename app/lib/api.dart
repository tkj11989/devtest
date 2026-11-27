import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:google_sign_in/google_sign_in.dart';

/// All rule-bearing writes go through Cloud Functions; the client never edits credits or pool membership.
class Api {
  Api._();
  static final fn = FirebaseFunctions.instance;
  static final db = FirebaseFirestore.instance;
  static String get uid => FirebaseAuth.instance.currentUser!.uid;

  static Future<T> call<T>(String name, [Map<String, dynamic> data = const {}]) async {
    final r = await fn.httpsCallable(name).call(data);
    return r.data as T;
  }

  static Future<void> signIn() async {
    final g = await GoogleSignIn().signIn();
    if (g == null) return;
    final a = await g.authentication;
    await FirebaseAuth.instance.signInWithCredential(
        GoogleAuthProvider.credential(accessToken: a.accessToken, idToken: a.idToken));
    await call('ensureUser');
  }

  // Tester
  /// Returns {packageName, installBufferHours}. No opt-in link: the app detects the install itself.
  static Future<Map> joinPool(String poolId) => call<Map>('joinPool', {'poolId': poolId});
  static Future<void> leavePool(String poolId) => call('leavePool', {'poolId': poolId});
  /// Reports to the backend that the package was found installed on this phone.
  static Future<Map> confirmInstalled(String poolId) => call<Map>('confirmInstalled', {'poolId': poolId});
  /// Lets the backend move a pool on once its install buffer timer has run out.
  static Future<Map> refreshPool(String poolId) => call<Map>('refreshPool', {'poolId': poolId});
  /// Daily test: the server stamps the start time; finishing records the day once 30 s have passed.
  static Future<Map> startTest(String poolId) => call<Map>('startTestSession', {'poolId': poolId});
  static Future<Map> finishTest(String sessionId) => call<Map>('finishTestSession', {'sessionId': sessionId});
  static Future<void> feedback(String poolId, int day, int rating, String text) =>
      call('submitFeedback', {'poolId': poolId, 'day': day, 'rating': rating, 'text': text});
  static Future<void> rewardedAd() => call('claimRewardedAd');
  static Future<void> report(String type, String id, String reason) =>
      call('fileReport', {'targetType': type, 'targetId': id, 'reason': reason});

  // Developer
  static Future<void> createPool(String appId) => call('createPool', {'appId': appId});
  static Future<void> cancelPool(String poolId) => call('cancelPool', {'poolId': poolId});
  static Future<void> setChecklist(String appId, Map<String, bool> items) =>
      call('updateChecklist', {'appId': appId, ...items});

  static Future<void> saveApp({String? appId, required Map<String, dynamic> info}) async {
    final ref = appId == null ? db.collection('apps').doc() : db.collection('apps').doc(appId);
    final data = {...info, 'ownerUid': uid};
    if (appId == null) {
      await ref.set({...data, 'appId': ref.id, 'checklist': {'groupAdded': false, 'buildReleased': false}});
    } else {
      await ref.update(data);
    }
  }

  // Streams for the screens
  static Stream<DocumentSnapshot<Map<String, dynamic>>> me() => db.collection('users').doc(uid).snapshots();
  static Stream<QuerySnapshot<Map<String, dynamic>>> fillingPools() =>
      // Installing pools can still have a free slot if someone left during the install buffer.
      db.collection('pools').where('state', whereIn: ['filling', 'installing']).orderBy('createdAt', descending: true).snapshots();
  static Stream<QuerySnapshot<Map<String, dynamic>>> myMemberships() =>
      db.collection('poolMembers').where('uid', isEqualTo: uid).snapshots();
  static Stream<QuerySnapshot<Map<String, dynamic>>> myApps() =>
      db.collection('apps').where('ownerUid', isEqualTo: uid).snapshots();
  static Stream<QuerySnapshot<Map<String, dynamic>>> myPools() =>
      db.collection('pools').where('ownerUid', isEqualTo: uid).snapshots();
  static Stream<QuerySnapshot<Map<String, dynamic>>> ledger() =>
      db.collection('creditLedger').where('uid', isEqualTo: uid).orderBy('createdAt', descending: true).snapshots();
}

String friendly(Object e) {
  const map = {
    'tester_slots_full': 'You have reached your package limit. Finish or leave a test to join another.',
    'same_app': 'You are already testing this app in another pool.',
    'own_app': 'You cannot test your own app.',
    'pool_full': 'This pool is full.',
    'pool_closed': 'This pool is closed.',
    'too_late': 'This pool has already started.',
    'user_blocked': 'Your account is temporarily blocked from joining.',
    'already_tested_today': 'Today\'s test is already recorded. Come back when the next day starts.',
    'pool_not_running': 'Testing starts after the install period.',
    'not_installed': 'Install the app first. We detect the install automatically.',
  };
  if (e is FirebaseFunctionsException) return map[e.message] ?? e.message ?? 'Something went wrong.';
  return 'Something went wrong.';
}
