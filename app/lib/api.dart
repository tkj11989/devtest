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
  static Future<String?> joinPool(String poolId) async =>
      (await call<Map>('joinPool', {'poolId': poolId}))['optInLink'] as String?;
  static Future<void> leavePool(String poolId) => call('leavePool', {'poolId': poolId});
  static Future<void> confirmInstalled(String poolId) => call('confirmInstalled', {'poolId': poolId});
  static Future<void> checkIn(String poolId, {String note = ''}) =>
      call('dailyCheckIn', {'poolId': poolId, 'note': note});
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

  static Future<void> saveApp({String? appId, required Map<String, dynamic> info, required String optInLink}) async {
    final ref = appId == null ? db.collection('apps').doc() : db.collection('apps').doc(appId);
    final data = {...info, 'ownerUid': uid};
    if (appId == null) {
      await ref.set({...data, 'appId': ref.id, 'checklist': {'groupAdded': false, 'buildReleased': false, 'linkPasted': false}});
    } else {
      await ref.update(data);
    }
    await db.collection('appSecrets').doc(ref.id).set({'optInLink': optInLink});
  }

  // Streams for the screens
  static Stream<DocumentSnapshot<Map<String, dynamic>>> me() => db.collection('users').doc(uid).snapshots();
  static Stream<QuerySnapshot<Map<String, dynamic>>> fillingPools() =>
      db.collection('pools').where('state', isEqualTo: 'filling').orderBy('createdAt', descending: true).snapshots();
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
    'tester_slots_full': 'You already have 2 active tests.',
    'same_app': 'You are already testing this app in another pool.',
    'own_app': 'You cannot test your own app.',
    'pool_full': 'This pool is full.',
    'pool_closed': 'This pool is closed.',
    'too_late': 'This pool has already started.',
    'user_blocked': 'Your account is temporarily blocked from joining.',
  };
  if (e is FirebaseFunctionsException) return map[e.message] ?? e.message ?? 'Something went wrong.';
  return 'Something went wrong.';
}
