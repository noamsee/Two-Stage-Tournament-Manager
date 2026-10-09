/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * מערכת ניהול טורניר דו-שלבי (Mobile Web Tournament Manager)
 * - עמוד נחיתה / כניסה (Login) עם אימות הרשאות:
 *   * noamsee@gmail.com = Owner (בעל הרשאות על)
 *   * אימיילים שהוגדרו ע"י ה-Owner = Admins (עריכת משחקים ונעילת פלייאוף)
 *   * שאר המשתמשים = Guests / אורחים (צפייה בתוצאות ובארכיון)
 * - ניהול טורניר פעיל וארכיון תוצאות טורנירים קודמים
 * - לוח Round-Robin בן 30 משחקים, אימות איסור תיקו, טבלאות בזמן אמת ופלייאוף נוקאאוט
 */

// Firebase Configuration (from Firebase Console)
const firebaseConfig = {
  apiKey: "AIzaSyC6qWQkyqBZswfkm2ltP1nO0_a0vf0V3mg",
  authDomain: "tournament-manager-cd0f4.firebaseapp.com",
  projectId: "tournament-manager-cd0f4",
  storageBucket: "tournament-manager-cd0f4.firebasestorage.app",
  messagingSenderId: "489777852099",
  appId: "1:489777852099:web:490303c8d61c34f069bc76"
};

// Initialize Firebase App
let firebaseApp = null;
let db = null;
let auth = null;
try {
    if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) {
            firebaseApp = firebase.initializeApp(firebaseConfig);
        } else {
            firebaseApp = firebase.app();
        }
        db = firebase.firestore();
        auth = firebase.auth();
        console.log("[Firebase] Initialized successfully with project:", firebaseConfig.projectId);
    } else {
        console.warn("[Firebase] SDK not loaded, running in offline fallback mode.");
    }
} catch (e) {
    console.error("[Firebase] Initialization error:", e);
}

class TournamentApp {
    constructor() {
        this.OWNER_EMAIL = "noamsee@gmail.com";
        this.currentRole = 'viewer';
        this.currentUser = null;
        this.db = db;
        this.auth = auth;
        this.unsubscribeTournaments = null;
        this.unsubscribeUsers = null;

        // אתחול מאגר המשתמשים האחוד (Single Source of Truth)
        this.initUnifiedUsersStore();

        // 15 קבוצות ברירת מחדל
        this.defaultTeams = [
            "מכבי תל אביב",
            "הפועל ירושלים",
            "הפועל תל אביב",
            "מכבי חיפה",
            "הפועל חולון",
            "בני הרצליה",
            "עירוני נס ציונה",
            "הפועל גליל עליון",
            "הפועל באר שבע",
            "מכבי ראשון לציון",
            "הפועל חיפה",
            "אליצור נתניה",
            "עירוני קריית אתא",
            "מכבי עירוני רעננה",
            "הפועל עפולה"
        ];

        // מאגר הטורנירים (טורניר פעיל + ארכיון תוצאות עבר)
        this.tournaments = this.loadTournaments();
        this.activeTournamentId = this.tournaments[0]?.id || 'tourney_active_2026';

        // נתוני הטורניר הפעיל הנוכחי
        this.teams = [...this.defaultTeams];
        this.groups = { 'Group A': [], 'Group B': [], 'Group C': [] };
        this.matches = [];
        this.standings = { 'Group A': [], 'Group B': [], 'Group C': [] };
        this.playoffSeeds = [];
        this.playoffMatches = { qf: [], sf: [], final: null };

        this.currentFilter = 'all';
        this.currentTeamFilter = 'all';
        this.alertTimeout = null;

        // הטאב שהיה פתוח לפני רענון הדף. נקרא כאן, לפני שתהליך הטעינה מחליף טאבים ודורס את הערך השמור
        this.savedTabOnLoad = null;
        try { this.savedTabOnLoad = sessionStorage.getItem('tournament_active_tab'); } catch (e) {}

        // גרסת מובייל: עץ פלייאוף מוקטן שנכנס למסך, ומשחק נפתח לעריכה בהקשה
        this.mobileQuery = window.matchMedia('(max-width: 640px)');
        this.openPlayoffMatchId = null;
        this.mobileQuery.addEventListener('change', () => {
            this.openPlayoffMatchId = null;
            if (document.querySelector('#playoff-bracket-container .bracket-tree')) {
                this.renderPlayoffBracket();
            }
        });

        // העדפות צפייה מותאמות אישית לאורח (בחירת טורניר, בית וקבוצה למעקב)
        try {
            this.guestPreferences = JSON.parse(localStorage.getItem('tournament_guest_pref') || 'null');
        } catch (e) {
            this.guestPreferences = null;
        }
    }

    init() {
        // טעינת הטורניר הנבחר
        this.loadTournamentData(this.activeTournamentId);
        
        // רינדור רשימות הבחירה של הטורנירים (בדף הלוגין ובהדר)
        this.populateTournamentSelectors();

        // ווידוא ששדה המייל תמיד פתוח להקלדה חופשית
        const loginEmail = document.getElementById('loginEmail');
        if (loginEmail) {
            loginEmail.disabled = false;
            loginEmail.readOnly = false;
        }

        // האזנה למצב התחברות ב-Firebase Auth
        this.initFirebaseAuthListener();

        // התחלת סנכרון זמן אמת מ-Cloud Firestore
        this.startRealtimeCloudSync();

        // בדיקה אם המשתמש כבר מחובר ב-sessionStorage
        try {
            const savedUser = JSON.parse(sessionStorage.getItem('tournament_current_user') || 'null');
            if (savedUser && savedUser.email) {
                this.authenticateUser(savedUser.email, false, savedUser.name, savedUser.provider);
                return;
            }
        } catch (e) {}

        // הצגת מסך הלוגין כברירת מחדל
        this.showLoginScreen();
    }

    initFirebaseAuthListener() {
        if (!this.auth) return;

        this.auth.onAuthStateChanged(user => {
            if (user) {
                console.log("[Firebase Auth] User state changed: Logged in as", user.email);
                const email = (user.email || '').toLowerCase();
                const displayName = user.displayName || email.split('@')[0];
                const provider = user.providerData && user.providerData[0] && user.providerData[0].providerId === 'google.com'
                    ? 'google'
                    : 'email';
                this.authenticateUser(email, false, displayName, provider);
            } else {
                console.log("[Firebase Auth] User state changed: Signed out");
            }
        });
    }

    startRealtimeCloudSync() {
        if (!this.db) return;

        // 1. האזנה בזמן אמת לשינויים בטורנירים (Firestore -> כל המכשירים)
        try {
            this.unsubscribeTournaments = this.db.collection('tournaments').onSnapshot(snapshot => {
                if (snapshot && !snapshot.empty) {
                    const cloudTournaments = [];
                    snapshot.forEach(doc => {
                        cloudTournaments.push({ id: doc.id, ...doc.data() });
                    });
                    
                    // מיון כך שהטורניר הפעיל יהיה ראשון
                    cloudTournaments.sort((a, b) => {
                        if (a.isArchived === b.isArchived) return (b.createdAt || '').localeCompare(a.createdAt || '');
                        return a.isArchived ? 1 : -1;
                    });

                    this.tournaments = cloudTournaments;
                    this.sanitizeTournamentNames();
                    this.saveTournamentsListLocally();
                    this.populateTournamentSelectors();
                    this.renderOwnerTournamentsList();

                    // טעינה ורענון הנתונים של הטורניר הנוכחי המוצג
                    const currentDoc = this.tournaments.find(t => t.id === this.activeTournamentId) || this.tournaments[0];
                    if (currentDoc) {
                        this.activeTournamentId = currentDoc.id;
                        this.loadTournamentData(currentDoc.id);
                    }
                    console.log("[Firestore] Real-time sync: Received updated tournaments from cloud (" + cloudTournaments.length + ")");
                } else if (snapshot && snapshot.empty) {
                    // אם מסד הנתונים בענן עדיין ריק, נעלה את הטורנירים הראשוניים לענן!
                    console.log("[Firestore] Cloud database is empty. Uploading initial tournaments...");
                    this.uploadAllTournamentsToCloud();
                }
            }, err => {
                console.warn("[Firestore] Tournaments snapshot error:", err);
            });
        } catch (e) {
            console.error("[Firestore] Error setting up tournaments listener:", e);
        }

        // 2. האזנה בזמן אמת למשתמשי המערכת
        try {
            this.unsubscribeUsers = this.db.collection('users').onSnapshot(snapshot => {
                if (snapshot && !snapshot.empty) {
                    const cloudUsers = [];
                    snapshot.forEach(doc => {
                        cloudUsers.push(doc.data());
                    });
                    this.saveUnifiedUsersLocally(cloudUsers);
                    this.renderUsersManagement();
                    console.log("[Firestore] Real-time sync: Received updated users list (" + cloudUsers.length + ")");
                } else if (snapshot && snapshot.empty) {
                    this.uploadAllUsersToCloud();
                }
            }, err => {
                console.warn("[Firestore] Users snapshot error:", err);
            });
        } catch (e) {
            console.error("[Firestore] Error setting up users listener:", e);
        }
    }

    async uploadAllTournamentsToCloud() {
        if (!this.db) return;
        try {
            const batch = this.db.batch();
            this.tournaments.forEach(t => {
                const docRef = this.db.collection('tournaments').doc(t.id);
                batch.set(docRef, t, { merge: true });
            });
            await batch.commit();
            console.log("[Firestore] Initial tournaments batch uploaded successfully!");
        } catch (e) {
            console.error("[Firestore] Failed to upload initial tournaments:", e);
        }
    }

    async uploadAllUsersToCloud() {
        if (!this.db) return;
        try {
            const users = this.getUnifiedUsers();
            const batch = this.db.batch();
            users.forEach(u => {
                const docId = (u.email || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
                if (docId) {
                    const docRef = this.db.collection('users').doc(docId);
                    batch.set(docRef, u, { merge: true });
                }
            });
            await batch.commit();
            console.log("[Firestore] Initial users uploaded successfully!");
        } catch (e) {
            console.error("[Firestore] Failed to upload users to cloud:", e);
        }
    }

    async loginWithGoogle() {
        if (!this.auth) {
            this.showAlert("שירות האימות אינו זמין כעת. נסה להתחבר עם אימייל וסיסמה.", "error");
            return;
        }

        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        try {
            const result = await this.auth.signInWithPopup(provider);
            const user = result.user;
            const email = (user.email || '').toLowerCase();
            const name = user.displayName || email.split('@')[0];
            const picture = user.photoURL || '';

            this.showAlert(`ברוך הבא ${name}! התחברת בהצלחה עם Google.`, "success");
            this.authenticateUser(email, true, name, 'google');

            if (this.currentUser && picture) {
                this.currentUser.picture = picture;
                sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));
                this.updateUserSessionUI();
            }
        } catch (error) {
            console.error("[Firebase Auth] Google Sign-in error:", error);
            if (error.code === 'auth/popup-closed-by-user') {
                this.showAlert("חלון ההתחברות נסגר.", "info");
            } else if (error.code === 'auth/unauthorized-domain') {
                this.showAlert("דומיין זה טרם אושר ב-Firebase. אפשר להתחבר כרגע עם אימייל וסיסמה (1234).", "warning");
            } else {
                this.showAlert(`שגיאה: ${error.message}`, "error");
            }
        }
    }

    async fallbackPopupGoogleAuth() {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        try {
            const result = await this.auth.signInWithPopup(provider);
            const user = result.user;
            const email = (user.email || '').toLowerCase();
            const name = user.displayName || email.split('@')[0];
            const picture = user.photoURL || '';

            this.showAlert(`ברוך הבא ${name}! התחברת בהצלחה עם Google.`, "success");
            this.authenticateUser(email, true, name, 'google');

            if (this.currentUser && picture) {
                this.currentUser.picture = picture;
                sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));
                this.updateUserSessionUI();
            }
        } catch (error) {
            console.warn("[Firebase Auth] Google Popup warning:", error);
            if (error.code === 'auth/popup-closed-by-user') {
                this.showAlert("חלון ההתחברות נסגר.", "info");
            } else {
                this.showAlert("בדפדפן זה ניתן להתחבר ישירות ובמהירות עם אימייל וסיסמה (1234).", "info");
            }
        }
    }

    switchAuthMode(mode = 'login') {
        this.currentAuthMode = mode;
        const tabLogin = document.getElementById('tabBtnLogin');
        const tabSignup = document.getElementById('tabBtnSignup');
        const formLogin = document.getElementById('form-login');
        const formSignup = document.getElementById('form-signup');
        const authDividerText = document.getElementById('authDividerText');

        if (mode === 'signup') {
            if (tabLogin) { tabLogin.classList.remove('active'); tabLogin.setAttribute('aria-selected', 'false'); }
            if (tabSignup) { tabSignup.classList.add('active'); tabSignup.setAttribute('aria-selected', 'true'); }
            if (formLogin) formLogin.classList.add('hidden');
            if (formSignup) formSignup.classList.remove('hidden');
            if (authDividerText) authDividerText.textContent = 'או הרשמה באמצעות כתובת אימייל';
        } else {
            if (tabLogin) { tabLogin.classList.add('active'); tabLogin.setAttribute('aria-selected', 'true'); }
            if (tabSignup) { tabSignup.classList.remove('active'); tabSignup.setAttribute('aria-selected', 'false'); }
            if (formLogin) formLogin.classList.remove('hidden');
            if (formSignup) formSignup.classList.add('hidden');
            if (authDividerText) authDividerText.textContent = 'או באמצעות כתובת אימייל';
        }
    }

    /* ========================================================
       ניהול מסכים ותצוגה (Screens: Login vs Main)
       ======================================================== */

    showLoginScreen() {
        const loginScreen = document.getElementById('screen-login');
        const mainScreen = document.getElementById('screen-main');
        if (loginScreen) loginScreen.classList.remove('hidden');
        if (mainScreen) mainScreen.classList.add('hidden');
        this.populateTournamentSelectors();
        
        const loginEmail = document.getElementById('loginEmail');
        if (loginEmail) {
            loginEmail.disabled = false;
            loginEmail.readOnly = false;
        }
    }

    showMainScreen() {
        const loginScreen = document.getElementById('screen-login');
        const mainScreen = document.getElementById('screen-main');
        if (loginScreen) loginScreen.classList.add('hidden');
        if (mainScreen) mainScreen.classList.remove('hidden');

        this.renderTeamInputs();
        this.renderMatches();
        this.calculateStandings();
        if (this.playoffSeeds && this.playoffSeeds.length === 8) {
            this.renderPlayoffBracket();
        }
        this.switchTab('setup');
    }

    /* ========================================================
       מאגר משתמשים אחוד (Single Source of Truth: Unified Users Store)
       ======================================================== */

    initUnifiedUsersStore() {
        let users = [];
        try {
            const raw = localStorage.getItem('tournament_unified_users');
            if (raw) users = JSON.parse(raw);
        } catch {}

        if (!Array.isArray(users) || users.length === 0) {
            let oldRegistered = [];
            try {
                const regRaw = localStorage.getItem('tournament_registered_users');
                if (regRaw) oldRegistered = JSON.parse(regRaw);
            } catch {}

            let oldAdmins = [];
            try {
                const admRaw = localStorage.getItem('tournament_manager_admins');
                if (admRaw) oldAdmins = JSON.parse(admRaw);
            } catch {}

            const ownerPass = localStorage.getItem('tournament_owner_password') || '1234';

            users.push({
                name: 'Noam Seelenfreund',
                email: this.OWNER_EMAIL.toLowerCase(),
                role: 'owner',
                password: ownerPass,
                provider: 'google/email',
                registeredAt: 'מנהל ראשי (מייסד)',
                isProtected: true
            });

            oldRegistered.forEach(u => {
                const email = (u.email || '').trim().toLowerCase();
                if (email && email !== this.OWNER_EMAIL.toLowerCase() && !users.some(x => x.email === email)) {
                    users.push({
                        name: u.name || email.split('@')[0],
                        email,
                        role: u.role || 'viewer',
                        password: u.password || '1234',
                        provider: u.provider || 'email',
                        registeredAt: u.registeredAt || new Date().toLocaleDateString('he-IL'),
                        isProtected: false
                    });
                }
            });

            oldAdmins.forEach(a => {
                const email = (a.email || '').trim().toLowerCase();
                if (email && email !== this.OWNER_EMAIL.toLowerCase()) {
                    const existing = users.find(x => x.email === email);
                    if (existing) {
                        existing.role = 'admin';
                    } else {
                        users.push({
                            name: a.name || email.split('@')[0],
                            email,
                            role: 'admin',
                            password: '1234',
                            provider: 'email',
                            registeredAt: a.addedAt || new Date().toLocaleDateString('he-IL'),
                            isProtected: false
                        });
                    }
                }
            });

            localStorage.setItem('tournament_unified_users', JSON.stringify(users));
        } else {
            let owner = users.find(u => u.email.toLowerCase() === this.OWNER_EMAIL.toLowerCase());
            if (!owner) {
                users.unshift({
                    name: 'Noam Seelenfreund',
                    email: this.OWNER_EMAIL.toLowerCase(),
                    role: 'owner',
                    password: localStorage.getItem('tournament_owner_password') || '1234',
                    provider: 'google/email',
                    registeredAt: 'מנהל ראשי (מייסד)',
                    isProtected: true
                });
                localStorage.setItem('tournament_unified_users', JSON.stringify(users));
            } else {
                owner.role = 'owner';
                owner.isProtected = true;
                if (!owner.password) owner.password = '1234';
                if (owner.name === 'נועם סלע') {
                    owner.name = 'Noam Seelenfreund';
                    localStorage.setItem('tournament_unified_users', JSON.stringify(users));
                }
            }
        }
        return users;
    }

    getUnifiedUsers() {
        try {
            const raw = localStorage.getItem('tournament_unified_users');
            return raw ? JSON.parse(raw) : this.initUnifiedUsersStore();
        } catch {
            return this.initUnifiedUsersStore();
        }
    }

    saveUnifiedUsersLocally(users) {
        localStorage.setItem('tournament_unified_users', JSON.stringify(users));
        localStorage.setItem('tournament_registered_users', JSON.stringify(users));
        const owner = users.find(u => u.email.toLowerCase() === this.OWNER_EMAIL.toLowerCase());
        if (owner && owner.password) {
            localStorage.setItem('tournament_owner_password', owner.password);
        }
        const admins = users.filter(u => u.role === 'admin').map(u => ({ email: u.email, name: u.name, addedAt: u.registeredAt }));
        localStorage.setItem('tournament_manager_admins', JSON.stringify(admins));
    }

    saveUnifiedUsers(users) {
        this.saveUnifiedUsersLocally(users);
        if (this.db) {
            try {
                const batch = this.db.batch();
                users.forEach(u => {
                    const docId = (u.email || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
                    if (docId) {
                        const docRef = this.db.collection('users').doc(docId);
                        batch.set(docRef, u, { merge: true });
                    }
                });
                batch.commit().catch(e => console.warn("[Firestore] Failed to save users batch:", e));
            } catch (e) {
                console.warn("[Firestore] Error in saveUnifiedUsers:", e);
            }
        }
    }

    getUserByEmail(email) {
        if (!email) return null;
        const clean = email.trim().toLowerCase();
        const users = this.getUnifiedUsers();
        return users.find(u => u.email.toLowerCase() === clean) || null;
    }

    getRegisteredUsers() {
        return this.getUnifiedUsers();
    }

    getOwnerPassword() {
        const owner = this.getUserByEmail(this.OWNER_EMAIL);
        return owner?.password || '1234';
    }

    setOwnerPassword(newPassword) {
        const users = this.getUnifiedUsers();
        const owner = users.find(u => u.email.toLowerCase() === this.OWNER_EMAIL.toLowerCase());
        if (owner) {
            owner.password = newPassword;
            this.saveUnifiedUsers(users);
        }
    }

    loadAdmins() {
        const users = this.getUnifiedUsers();
        return users.filter(u => u.role === 'admin').map(u => ({ email: u.email, name: u.name, addedAt: u.registeredAt }));
    }

    saveAdmins() {
        // מנוהל אוטומטית דרך saveUnifiedUsers
    }

    handleSignUp() {
        const nameInput = document.getElementById('signupName');
        const emailInput = document.getElementById('signupEmail');
        const passInput = document.getElementById('signupPassword');
        const passConfirmInput = document.getElementById('signupPasswordConfirm');

        const name = nameInput ? nameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const pass = passInput ? passInput.value : '';
        const passConfirm = passConfirmInput ? passConfirmInput.value : '';

        if (!name) {
            this.showAlert("אנא הזן את שמך המלא להרשמה.", "error");
            return;
        }
        if (!email || !email.includes('@')) {
            this.showAlert("אנא הזן כתובת אימייל חוקית.", "error");
            return;
        }
        if (pass.length < 4) {
            this.showAlert("הסיסמה חייבת להכיל לפחות 4 תווים.", "error");
            return;
        }
        if (pass !== passConfirm) {
            this.showAlert("אימות הסיסמה אינו תואם. אנא נסה שוב.", "error");
            return;
        }

        const users = this.getUnifiedUsers();
        const existing = users.find(u => u.email.toLowerCase() === email);
        if (existing) {
            this.showAlert("כתובת אימייל זו כבר רשומה במערכת! מעביר למסך כניסה...", "warning");
            this.switchAuthMode('login');
            const loginEmail = document.getElementById('loginEmail');
            if (loginEmail) loginEmail.value = email;
            return;
        }

        users.push({
            name,
            email,
            role: 'viewer',
            password: pass,
            registeredAt: new Date().toLocaleDateString('he-IL'),
            provider: 'email',
            isProtected: false
        });
        this.saveUnifiedUsers(users);

        const tourneySelect = document.getElementById('signupTournamentSelect');
        if (tourneySelect && tourneySelect.value) {
            this.switchTournament(tourneySelect.value, false);
        }

        this.authenticateUser(email, true, name, 'email');
    }

    handleLogin() {
        const emailInput = document.getElementById('loginEmail');
        const passInput = document.getElementById('loginPassword');
        const enteredEmail = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const enteredPass = passInput ? passInput.value.trim() : '';

        const tourneySelect = document.getElementById('loginTournamentSelect');
        const houseSelect = document.getElementById('loginHouseSelect');
        const teamSelect = document.getElementById('loginTeamSelect');

        if (tourneySelect && tourneySelect.value) {
            this.switchTournament(tourneySelect.value, false);
        }

        const selectedGroup = (houseSelect && houseSelect.value) ? houseSelect.value : 'all';
        const selectedTeam = (teamSelect && teamSelect.value) ? teamSelect.value.trim() : '';
        if (tourneySelect && tourneySelect.value) {
            this.guestPreferences = {
                tourneyId: tourneySelect.value,
                groupKey: selectedGroup,
                teamName: selectedTeam
            };
            try {
                localStorage.setItem('tournament_guest_pref', JSON.stringify(this.guestPreferences));
            } catch (e) {}

            if (selectedGroup && selectedGroup !== 'all') {
                this.currentFilter = selectedGroup;
            } else {
                this.currentFilter = 'all';
            }
        }

        if (!enteredEmail || !enteredEmail.includes('@')) {
            this.showAlert("אנא הזן כתובת אימייל חוקית לכניסה.", "error");
            return;
        }

        const user = this.getUserByEmail(enteredEmail);
        if (user) {
            const expectedPass = user.password || '1234';
            if (enteredPass !== expectedPass) {
                this.showAlert(`סיסמה שגויה עבור ${enteredEmail}. (סיסמת ברירת מחדל: 1234)`, "error");
                return;
            }
            this.authenticateUser(enteredEmail, true, user.name, 'email');
            return;
        }

        // משתמש חדש לגמרי שנכנס עם סיסמת ברירת מחדל 1234
        if (enteredPass !== '1234') {
            this.showAlert("משתמש לא נמצא או סיסמה שגויה. עבור משתמשים חדשים הסיסמה הראשונית היא: 1234", "warning");
            return;
        }

        const users = this.getUnifiedUsers();
        users.push({
            name: enteredEmail.split('@')[0],
            email: enteredEmail,
            role: 'viewer',
            password: '1234',
            registeredAt: new Date().toLocaleDateString('he-IL'),
            provider: 'email',
            isProtected: false
        });
        this.saveUnifiedUsers(users);
        this.authenticateUser(enteredEmail, true, enteredEmail.split('@')[0], 'email');
    }

    loginAsGuest() {
        const tourneySelect = document.getElementById('loginTournamentSelect');
        const houseSelect = document.getElementById('loginHouseSelect');
        const teamSelect = document.getElementById('loginTeamSelect');

        const selectedTourneyId = tourneySelect && tourneySelect.value ? tourneySelect.value : this.activeTournamentId;
        const selectedGroup = (houseSelect && houseSelect.value) ? houseSelect.value : 'all';
        const selectedTeam = (teamSelect && teamSelect.value) ? teamSelect.value.trim() : '';

        // שמירת העדפות המעקב של האורח ישירות מהלוגין
        this.guestPreferences = {
            tourneyId: selectedTourneyId,
            groupKey: selectedGroup,
            teamName: selectedTeam
        };
        try {
            localStorage.setItem('tournament_guest_pref', JSON.stringify(this.guestPreferences));
        } catch (e) {}

        // החלת סינון בית
        if (selectedGroup && selectedGroup !== 'all') {
            this.currentFilter = selectedGroup;
        } else {
            this.currentFilter = 'all';
        }

        if (selectedTourneyId) {
            this.switchTournament(selectedTourneyId, false);
        }

        // חיבור ישיר כאורח ללא הצגת מודאלים נוספים
        this.authenticateUser('guest@tournament.local', true, 'אורח', 'guest');
    }

    authenticateUser(email, showNotification = true, displayName = null, provider = 'email') {
        const cleanEmail = (email || this.OWNER_EMAIL).trim().toLowerCase();
        let user = this.getUserByEmail(cleanEmail);

        if (!user && cleanEmail.includes('@') && !cleanEmail.includes('guest')) {
            const newUser = {
                name: displayName || cleanEmail.split('@')[0],
                email: cleanEmail,
                role: (cleanEmail === this.OWNER_EMAIL.toLowerCase()) ? 'owner' : 'viewer',
                password: '1234',
                provider: provider || 'email',
                registeredAt: new Date().toLocaleDateString('he-IL'),
                isProtected: (cleanEmail === this.OWNER_EMAIL.toLowerCase())
            };
            const users = this.getUnifiedUsers();
            users.push(newUser);
            this.saveUnifiedUsers(users);
            user = newUser;
        }

        let role = 'viewer';
        let cleanName = displayName || (user ? user.name : cleanEmail.split('@')[0]);

        if (cleanEmail === this.OWNER_EMAIL.toLowerCase()) {
            role = 'owner';
            if (user) cleanName = user.name;
        } else if (user && user.role === 'admin') {
            role = 'admin';
            cleanName = user.name;
        } else if (provider === 'guest' || cleanEmail.includes('guest')) {
            role = 'viewer';
            cleanName = 'אורח';
        } else if (user) {
            role = user.role || 'viewer';
            cleanName = user.name;
        }

        let displayLabel = '';
        if (role === 'owner') {
            displayLabel = `👑 בעלים (${cleanName})`;
        } else if (role === 'admin') {
            displayLabel = `⚡ מנהל (${cleanName})`;
        } else if (provider === 'guest') {
            displayLabel = '👁️ אורח (Guest)';
        } else {
            displayLabel = `👁️ ${cleanName}`;
        }

        this.currentUser = {
            email: cleanEmail,
            role,
            name: cleanName,
            displayName: displayLabel,
            provider
        };
        sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));

        // שחזור טאב בכניסה אוטומטית (רענון דף או אימות חוזר): הטאב שנשמר בטעינת הדף,
        // ואם כבר שוחזר - הטאב הנוכחי, כדי שאימות חוזר ברקע לא יקפיץ לטאב ברירת המחדל
        let tabToRestore = null;
        if (!showNotification) {
            tabToRestore = this.savedTabOnLoad;
            if (!tabToRestore) {
                try { tabToRestore = sessionStorage.getItem('tournament_active_tab'); } catch (e) {}
            }
        }
        this.savedTabOnLoad = null;

        this.switchRole(role);
        this.updateUserSessionUI();
        this.showMainScreen();

        this.renderUsersManagement();
        this.renderOwnerTournamentsList();

        if (showNotification) {
            const providerText = (provider === 'google') ? 'באמצעות Google / Gmail' : '';
            if (role === 'owner') {
                this.showAlert(`ברוך הבא! נכנסת כמנהל על (Owner - ${cleanEmail}) ${providerText} עם גישה מלאה.`, "success");
            } else if (role === 'admin') {
                this.showAlert(`שלום ${cleanName}! נכנסת כמנהל מורשה (Admin) ${providerText}.`, "success");
            } else {
                this.showAlert(`שלום ${cleanName}! נכנסת למערכת הטורניר ${providerText}.`, "info");
            }
        }

        // אם המשתמש הוא אורח/צופה - מחילים ישירות את ההעדפות שנבחרו במסך הכניסה
        if (role === 'viewer') {
            this.renderGuestFollowedBanner();
            this.renderStandings();
            this.renderMatches();
            const targetTab = (this.format === 'knockout_only') ? 'playoffs' : 'group-stage';
            this.switchTab(targetTab);
        }

        // שחזור הטאב לאחר רענון, רק אם הוא קיים ומותר לתפקיד הנוכחי
        const tabAllowed = tabToRestore && document.getElementById(`tab-${tabToRestore}`)
            && !(role === 'viewer' && (tabToRestore === 'setup' || tabToRestore === 'users'))
            && !(role !== 'owner' && tabToRestore === 'users');
        if (tabAllowed) this.switchTab(tabToRestore);
    }

    logout() {
        const loggedOutEmail = this.currentUser ? this.currentUser.email : '';
        this.currentUser = null;
        sessionStorage.removeItem('tournament_current_user');
        sessionStorage.removeItem('tournament_active_tab');

        if (this.auth) {
            try { this.auth.signOut(); } catch (e) {}
        }

        if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
            google.accounts.id.disableAutoSelect();
            if (loggedOutEmail) {
                try { google.accounts.id.revoke(loggedOutEmail, () => {}); } catch (e) {}
            }
        }

        this.showLoginScreen();
        const emailInput = document.getElementById('loginEmail');
        if (emailInput) {
            emailInput.value = '';
            emailInput.disabled = false;
        }
        const passInput = document.getElementById('loginPassword');
        if (passInput) passInput.value = '';

        this.showAlert("התנתקת בהצלחה מהמערכת.", "warning");
    }

    updateUserSessionUI() {
        const badge = document.getElementById('currentUserBadge');
        if (badge && this.currentUser) {
            const googleIconHtml = (this.currentUser.provider === 'google') 
                ? `<svg viewBox="0 0 48 48" width="14" height="14" style="vertical-align:middle; margin-left:4px;"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>` 
                : '';
            badge.innerHTML = `${googleIconHtml}${this.currentUser.displayName}`;
            badge.className = `user-badge user-badge-${this.currentUser.role}`;
        }
        this.updateGuestTournamentBadge();
    }

    updateGuestTournamentBadge() {
        const guestTourneyEl = document.getElementById('guestTournamentName');
        const currTourney = this.tournaments.find(t => t.id === this.activeTournamentId) || this.tournaments[0];
        if (guestTourneyEl && currTourney) {
            guestTourneyEl.textContent = currTourney.name + (currTourney.isArchived ? ' (סגור)' : '');
        }
    }

    isCurrentTournamentClosed() {
        const curr = this.tournaments.find(t => t.id === this.activeTournamentId);
        return !!(curr && curr.isArchived);
    }

    isGroupStageLocked() {
        if (this.isCurrentTournamentClosed()) return true;
        if (this.format === 'groups_and_playoff' && this.playoffSeeds && this.playoffSeeds.length > 0) {
            return true;
        }
        return false;
    }

    switchRole(newRole) {
        this.currentRole = newRole;
        document.body.className = `role-${newRole}`;

        const isClosed = this.isCurrentTournamentClosed();
        // אם הטורניר סגור - נעול לחלוטין לשינויים לכולם (כולל Admin ו-Owner)!
        const isReadOnly = (newRole === 'viewer') || isClosed;

        const allInputs = document.querySelectorAll('#screen-main input:not(#newAdminEmailInput):not(#newTournamentNameInput):not(#wizardTourneyName)');
        allInputs.forEach(input => {
            input.disabled = isReadOnly;
        });

        const adminButtons = document.querySelectorAll('.admin-editable');
        adminButtons.forEach(btn => {
            // כפתור פתיחת הטורניר מחדש וכפתור פתיחת אשף לטורניר חדש נשארים זמינים עבור מנהלים/בעלים
            if (btn.id === 'setupCloseTournamentBtn' || btn.id === 'headerBtnNewTourney' || btn.classList.contains('btn-new-tourney')) {
                btn.disabled = (newRole === 'viewer');
                btn.title = "";
            } else {
                btn.disabled = isReadOnly;
                if (isClosed && newRole !== 'viewer') {
                    btn.title = "הטורניר סגור ונעול לעריכה. לפתיחתו יש ללחוץ על 'פתח טורניר מחדש'.";
                }
            }
        });

        // כפתור סגירה/פתיחה בפאנל בעלים
        const ownerCloseBtn = document.getElementById('ownerCloseTourneyBtn');
        if (ownerCloseBtn) {
            ownerCloseBtn.disabled = (newRole !== 'owner');
        }

        const setupNotice = document.getElementById('setup-header-subtitle');
        if (setupNotice) {
            if (isClosed) {
                setupNotice.textContent = '🔒 הטורניר סגור ונעול לעריכה (מצב קריאה בלבד). לפתיחתו יש ללחוץ על "פתח טורניר מחדש".';
                setupNotice.style.color = '#b45309';
                setupNotice.style.fontWeight = '700';
            } else {
                setupNotice.textContent = 'מיועד ל-Admin/Owner בלבד. הזן או עדכן את שמות הקבוצות:';
                setupNotice.style.color = '';
                setupNotice.style.fontWeight = '';
            }
        }

        // ניתוב אוטומטי של צופה/אורח בלבד הרחק מטאב ההגדרות או ניהול המשתמשים
        if (newRole === 'viewer') {
            const currentTabBtn = document.querySelector('.tab-btn.active');
            const currentTabClick = currentTabBtn ? currentTabBtn.getAttribute('onclick') : '';
            if (!currentTabClick || currentTabClick.includes('setup') || currentTabClick.includes('users')) {
                const targetTab = (this.format === 'knockout_only') ? 'playoffs' : 'group-stage';
                this.switchTab(targetTab);
            }
        }

        const loginEmail = document.getElementById('loginEmail');
        if (loginEmail) {
            loginEmail.disabled = false;
            loginEmail.readOnly = false;
        }

        this.renderMatches();
        this.renderStandings();
        if (this.playoffMatches) {
            this.renderPlayoffBracket();
        }
        this.updateGuestTournamentBadge();
    }

    getAllUsers() {
        return this.getUnifiedUsers();
    }

    renderAdminManagement() {
        this.renderUsersManagement();
    }

    renderUsersManagement() {
        const tbody = document.getElementById('usersListTableBody');
        if (!tbody) return;

        const users = this.getAllUsers();
        if (users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#6b5b45; padding:16px;">אין משתמשים במערכת.</td></tr>`;
            return;
        }

        tbody.innerHTML = users.map(u => {
            let roleBadge = '';
            if (u.role === 'owner') {
                roleBadge = `<span style="background:#fef3c7; color:#92400e; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:700;">👑 בעל המערכת (Owner)</span>`;
            } else if (u.role === 'admin') {
                roleBadge = `<span style="background:#dbeafe; color:#1e40af; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:700;">⚡ מנהל (Admin)</span>`;
            } else {
                roleBadge = `<span style="background:#ede2cf; color:#57493a; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:600;">👁️ צופה (Viewer)</span>`;
            }

            const isOwnerUser = u.email === this.OWNER_EMAIL.toLowerCase();

            const actionsHtml = isOwnerUser 
                ? `
                    <div style="display:flex; gap:6px; justify-content:center; flex-wrap:wrap;">
                        <button type="button" class="btn-edit-user" onclick="app.openEditUserModal('${u.email}')" title="עריכת שם, סיסמה ופרטים">
                            ✏️ ערוך פרטים
                        </button>
                        <button type="button" class="btn-sm btn-secondary" onclick="app.openResetPasswordModal('${u.email}')" title="איפוס סיסמה">
                            🔑 איפוס סיסמה
                        </button>
                    </div>
                `
                : `
                    <div style="display:flex; gap:6px; justify-content:center; flex-wrap:wrap;">
                        <button type="button" class="btn-edit-user" onclick="app.openEditUserModal('${u.email}')" title="עריכת שם, תפקיד וסיסמה">
                            ✏️ ערוך פרטים
                        </button>
                        <button type="button" class="btn-sm btn-secondary" onclick="app.openResetPasswordModal('${u.email}')" title="איפוס סיסמה למשתמש זה" style="padding:4px 8px; font-size:0.8rem;">
                            🔑 איפוס סיסמה
                        </button>
                        <button type="button" class="btn-delete-admin" onclick="app.removeUser('${u.email}')" title="מחק משתמש מהמערכת">
                            🗑️ הסר
                        </button>
                    </div>
                `;

            return `
                <tr>
                    <td style="font-weight:700; color:#271e16;">${u.name}</td>
                    <td style="direction:ltr; text-align:right; font-family:monospace; color:#4a3c2e;">${u.email}</td>
                    <td>${roleBadge}</td>
                    <td style="font-size:0.85rem; color:#6b5b45;">${u.provider === 'google' ? 'Google OAuth' : 'דוא"ל וסיסמה'}</td>
                    <td style="color:#6b5b45; font-size:0.85rem;">${u.registeredAt || '-'}</td>
                    <td style="text-align:center;">${actionsHtml}</td>
                </tr>
            `;
        }).join('');
    }

    openEditUserModal(userEmail) {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לערוך פרטי משתמשים!", "error");
            return;
        }
        const user = this.getUserByEmail(userEmail);
        if (!user) {
            this.showAlert("משתמש לא נמצא.", "error");
            return;
        }

        const modal = document.getElementById('edit-user-modal');
        const origEmail = document.getElementById('editUserOriginalEmail');
        const dispEmail = document.getElementById('editUserEmailDisplay');
        const nameInp = document.getElementById('editUserNameInput');
        const roleSel = document.getElementById('editUserRoleSelect');
        const passInp = document.getElementById('editUserPasswordInput');
        const note = document.getElementById('editUserRoleNote');

        if (origEmail) origEmail.value = user.email;
        if (dispEmail) dispEmail.value = user.email;
        if (nameInp) nameInp.value = user.name || '';
        if (passInp) passInp.value = user.password || '1234';

        const isOwner = user.email.toLowerCase() === this.OWNER_EMAIL.toLowerCase();
        if (roleSel) {
            if (isOwner) {
                roleSel.value = 'owner';
                roleSel.disabled = true;
                if (note) note.textContent = "חשבון בעל המערכת הראשי (קבוע).";
            } else {
                roleSel.disabled = false;
                roleSel.value = user.role || 'viewer';
                if (note) note.textContent = "באפשרותך לשנות בין מנהל (Admin) לצופה (Viewer).";
            }
        }

        if (modal) modal.classList.remove('hidden');
    }

    closeEditUserModal() {
        const modal = document.getElementById('edit-user-modal');
        if (modal) modal.classList.add('hidden');
    }

    submitEditUser() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לערוך משתמשים!", "error");
            return;
        }

        const origEmail = document.getElementById('editUserOriginalEmail');
        const nameInp = document.getElementById('editUserNameInput');
        const roleSel = document.getElementById('editUserRoleSelect');
        const passInp = document.getElementById('editUserPasswordInput');

        const email = origEmail ? origEmail.value.trim().toLowerCase() : '';
        const name = nameInp ? nameInp.value.trim() : '';
        const password = passInp ? passInp.value.trim() : '';
        const isOwner = email === this.OWNER_EMAIL.toLowerCase();
        const role = isOwner ? 'owner' : (roleSel ? roleSel.value : 'viewer');

        if (!name) {
            this.showAlert("אנא הזן שם עבור המשתמש.", "error");
            return;
        }
        if (!password) {
            this.showAlert("אנא הזן סיסמה עבור המשתמש.", "error");
            return;
        }

        const users = this.getUnifiedUsers();
        const user = users.find(u => u.email.toLowerCase() === email);
        if (!user) {
            this.showAlert("משתמש לא נמצא.", "error");
            return;
        }

        user.name = name;
        user.password = password;
        if (!isOwner) {
            user.role = role;
        }
        this.saveUnifiedUsers(users);

        if (this.currentUser && this.currentUser.email.toLowerCase() === email) {
            this.currentUser.name = name;
            if (isOwner) {
                this.currentUser.displayName = `👑 בעלים (${name})`;
            } else if (role === 'admin') {
                this.currentUser.displayName = `⚡ מנהל (${name})`;
            } else {
                this.currentUser.displayName = `👁️ ${name}`;
            }
            sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));
            this.updateUserSessionUI();
        }

        this.closeEditUserModal();
        this.renderUsersManagement();
        this.showAlert(`פרטי המשתמש ${name} (${email}) נשמרו בהצלחה!`, "success");
    }

    openAddUserModal() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי להוסיף משתמשים!", "error");
            return;
        }
        const modal = document.getElementById('add-user-modal');
        const nameInp = document.getElementById('newUserNameInput');
        const emailInp = document.getElementById('newUserEmailInput');
        const passInp = document.getElementById('newUserPasswordInput');
        if (nameInp) nameInp.value = '';
        if (emailInp) emailInp.value = '';
        if (passInp) passInp.value = '1234';
        if (modal) modal.classList.remove('hidden');
    }

    closeAddUserModal() {
        const modal = document.getElementById('add-user-modal');
        if (modal) modal.classList.add('hidden');
    }

    submitAddUser() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי להוסיף משתמשים!", "error");
            return;
        }

        const nameInp = document.getElementById('newUserNameInput');
        const emailInp = document.getElementById('newUserEmailInput');
        const roleSel = document.getElementById('newUserRoleSelect');
        const passInp = document.getElementById('newUserPasswordInput');

        const name = nameInp ? nameInp.value.trim() : '';
        const email = emailInp ? emailInp.value.trim().toLowerCase() : '';
        const role = roleSel ? roleSel.value : 'viewer';
        const password = passInp ? passInp.value.trim() : '1234';

        if (!name) {
            this.showAlert("אנא הזן שם עבור המשתמש.", "error");
            return;
        }
        if (!email || !email.includes('@')) {
            this.showAlert("אנא הזן כתובת אימייל חוקית.", "error");
            return;
        }
        if (email === this.OWNER_EMAIL.toLowerCase()) {
            this.showAlert("כתובת זו היא כתובת ה-Owner של המערכת.", "warning");
            return;
        }

        const users = this.getUnifiedUsers();
        if (users.some(u => u.email.toLowerCase() === email)) {
            this.showAlert("משתמש עם כתובת אימייל זו כבר קיים במערכת!", "warning");
            return;
        }

        users.push({
            name,
            email,
            role,
            password: password || '1234',
            registeredAt: new Date().toLocaleDateString('he-IL'),
            provider: 'email',
            isProtected: false
        });
        this.saveUnifiedUsers(users);

        this.closeAddUserModal();
        this.renderUsersManagement();
        this.showAlert(`המשתמש ${name} (${email}) נוסף בהצלחה עם תפקיד ${role === 'admin' ? 'מנהל' : 'צופה'}! סיסמה ראשונית: ${password}`, "success");
    }

    async removeUser(emailToRemove) {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי למחוק משתמשים!", "error");
            return;
        }

        const cleanEmail = (emailToRemove || '').trim().toLowerCase();
        if (cleanEmail === this.OWNER_EMAIL.toLowerCase()) {
            this.showAlert("לא ניתן למחוק את ה-Owner של המערכת!", "error");
            return;
        }

        if (!confirm(`האם אתה בטוח שברצונך להסיר את המשתמש ${cleanEmail} מהמערכת וממסד הנתונים?`)) {
            return;
        }

        // 1. הסרה מקומית
        let users = this.getUnifiedUsers();
        users = users.filter(u => u.email.toLowerCase() !== cleanEmail);
        this.saveUnifiedUsersLocally(users);

        // 2. מחיקה לצמיתות מ-Firestore בענן כדי שלא יחזור בריענון
        if (this.db) {
            try {
                const docId = cleanEmail.replace(/[^a-z0-9_.-]/g, '_');
                await this.db.collection('users').doc(docId).delete();

                // חיפוש מסמכים נוספים אם קיימים עבור אימייל זה
                const querySnap = await this.db.collection('users').where('email', '==', cleanEmail).get();
                if (!querySnap.empty) {
                    const batch = this.db.batch();
                    querySnap.forEach(d => batch.delete(d.ref));
                    await batch.commit();
                }
                console.log(`[Firestore] User ${cleanEmail} permanently deleted.`);
            } catch (err) {
                console.error("[Firestore] Error deleting user from Firestore:", err);
                this.showAlert("שגיאה במחיקת המשתמש ממסד הנתונים: " + err.message, "error");
                return;
            }
        }

        this.renderUsersManagement();
        this.showAlert(`המשתמש ${cleanEmail} הוסר בהצלחה מהמערכת וממסד הנתונים.`, "warning");
    }

    openResetPasswordModal(userEmail) {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לאפס סיסמאות!", "error");
            return;
        }

        const modal = document.getElementById('reset-password-modal');
        const disp = document.getElementById('resetPasswordUserEmailDisplay');
        const target = document.getElementById('resetPasswordTargetEmail');
        const newPassInp = document.getElementById('resetPasswordNewInput');

        if (disp) disp.textContent = userEmail;
        if (target) target.value = userEmail;
        if (newPassInp) newPassInp.value = '1234';

        if (modal) modal.classList.remove('hidden');
    }

    closeResetPasswordModal() {
        const modal = document.getElementById('reset-password-modal');
        if (modal) modal.classList.add('hidden');
    }

    submitResetPassword() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לאפס סיסמאות!", "error");
            return;
        }

        const target = document.getElementById('resetPasswordTargetEmail');
        const newPassInp = document.getElementById('resetPasswordNewInput');

        const email = target ? target.value.trim().toLowerCase() : '';
        const newPass = newPassInp ? newPassInp.value.trim() : '';

        if (!newPass) {
            this.showAlert("אנא הזן סיסמה חדשה.", "error");
            return;
        }

        const users = this.getUnifiedUsers();
        const user = users.find(u => u.email.toLowerCase() === email);
        if (user) {
            user.password = newPass;
            this.saveUnifiedUsers(users);
        } else {
            users.push({
                name: email.split('@')[0],
                email,
                role: 'viewer',
                password: newPass,
                registeredAt: new Date().toLocaleDateString('he-IL'),
                provider: 'email',
                isProtected: false
            });
            this.saveUnifiedUsers(users);
        }

        this.closeResetPasswordModal();
        this.renderUsersManagement();
        this.showAlert(`הסיסמה עבור ${email} אופסה בהצלחה ל: ${newPass}`, "success");
    }


    /* ========================================================
       ניהול טורנירים וארכיון תוצאות עבר (Multi-Tournament System)
       ======================================================== */

    loadTournaments() {
        const stored = localStorage.getItem('tournament_manager_tournaments_list');
        if (stored) {
            try { 
                const list = JSON.parse(stored);
                if (Array.isArray(list)) {
                    list.forEach(t => {
                        if (t.name && (t.name.includes('(ארכיון) (ארכיון)') || t.name.includes('(ארכיון)(ארכיון)'))) {
                            t.name = t.name.replace(/(\s*\(ארכיון\))+/g, '').trim();
                        }
                    });
                    return list;
                }
            } catch {}
        }

        // יצירת שני טורנירים ראשוניים: טורניר פעיל + ארכיון 2025 מוכן ומלא
        const activeTourney = {
            id: 'tourney_active_2026',
            name: 'טורניר עונת 2026 (פעיל)',
            createdAt: '2026-09-01',
            isArchived: false,
            teams: [...this.defaultTeams]
        };

        const archiveTourney = this.createMockArchiveTournament2025();

        const initialList = [activeTourney, archiveTourney];
        localStorage.setItem('tournament_manager_tournaments_list', JSON.stringify(initialList));
        return initialList;
    }

    saveTournamentsListLocally() {
        localStorage.setItem('tournament_manager_tournaments_list', JSON.stringify(this.tournaments));
    }

    saveTournamentsList() {
        this.saveTournamentsListLocally();
        if (this.db) {
            try {
                const batch = this.db.batch();
                this.tournaments.forEach(t => {
                    const docRef = this.db.collection('tournaments').doc(t.id);
                    batch.set(docRef, t);
                });
                batch.commit().catch(e => console.warn("[Firestore] Failed to save tournaments batch:", e));
            } catch (e) {
                console.warn("[Firestore] Error in saveTournamentsList:", e);
            }
        }
    }

    createMockArchiveTournament2025() {
        // טורניר עבר לדוגמה עם כל 30 המשחקים משוחקים, טבלאות מלאות ואלופה מוכתרת
        const teams = [...this.defaultTeams];
        const groups = {
            'Group A': teams.slice(0, 5).map((name, i) => ({ index: i, name, group: 'Group A' })),
            'Group B': teams.slice(5, 10).map((name, i) => ({ index: i + 5, name, group: 'Group B' })),
            'Group C': teams.slice(10, 15).map((name, i) => ({ index: i + 10, name, group: 'Group C' }))
        };

        const roundRobinTemplate = [
            [ { home: 0, away: 4 }, { home: 1, away: 3 } ],
            [ { home: 4, away: 3 }, { home: 0, away: 2 } ],
            [ { home: 1, away: 4 }, { home: 2, away: 3 } ],
            [ { home: 4, away: 2 }, { home: 0, away: 1 } ],
            [ { home: 3, away: 0 }, { home: 1, away: 2 } ]
        ];

        const matches = [];
        let matchCounter = 1;
        const groupConfigs = [
            { key: 'Group A', nameHe: "בית א'", startIndex: 0 },
            { key: 'Group B', nameHe: "בית ב'", startIndex: 5 },
            { key: 'Group C', nameHe: "בית ג'", startIndex: 10 }
        ];

        groupConfigs.forEach(grp => {
            roundRobinTemplate.forEach((roundPairs, roundIdx) => {
                const roundNum = roundIdx + 1;
                roundPairs.forEach(pair => {
                    const t1Idx = grp.startIndex + pair.home;
                    const t2Idx = grp.startIndex + pair.away;
                    const s1 = 70 + ((matchCounter * 7) % 27);
                    let s2 = 65 + ((matchCounter * 11) % 29);
                    if (s1 === s2) s2 += 3;

                    matches.push({
                        id: `match_arch_${matchCounter}`,
                        matchNumber: matchCounter,
                        groupId: grp.key,
                        groupNameHe: grp.nameHe,
                        round: roundNum,
                        team1Index: t1Idx,
                        team2Index: t2Idx,
                        team1Name: teams[t1Idx],
                        team2Name: teams[t2Idx],
                        score1: s1,
                        score2: s2,
                        winner: s1 > s2 ? 'team1' : 'team2'
                    });
                    matchCounter++;
                });
            });
        });

        // חישוב טבלאות
        const standings = {};
        ['Group A', 'Group B', 'Group C'].forEach(grpKey => {
            const grpTeams = groups[grpKey];
            const stats = grpTeams.map(t => ({
                teamIndex: t.index,
                teamName: teams[t.index],
                group: grpKey,
                played: 4,
                wins: 0,
                losses: 0,
                pointsFor: 0,
                pointsAgainst: 0,
                pointDiff: 0
            }));

            matches.filter(m => m.groupId === grpKey).forEach(m => {
                const t1 = stats.find(s => s.teamIndex === m.team1Index);
                const t2 = stats.find(s => s.teamIndex === m.team2Index);
                if (t1 && t2) {
                    t1.pointsFor += m.score1; t1.pointsAgainst += m.score2;
                    t2.pointsFor += m.score2; t2.pointsAgainst += m.score1;
                    if (m.winner === 'team1') { t1.wins++; t2.losses++; }
                    else { t2.wins++; t1.losses++; }
                }
            });

            stats.forEach(s => { s.pointDiff = s.pointsFor - s.pointsAgainst; });
            stats.sort((a, b) => (b.wins !== a.wins ? b.wins - a.wins : b.pointDiff - a.pointDiff));
            stats.forEach((s, idx) => { s.groupRank = idx + 1; });
            standings[grpKey] = stats;
        });

        const playoffSeeds = [
            { seed: 1, ...standings['Group A'][0] },
            { seed: 2, ...standings['Group B'][0] },
            { seed: 3, ...standings['Group C'][0] },
            { seed: 4, ...standings['Group A'][1] },
            { seed: 5, ...standings['Group B'][1] },
            { seed: 6, ...standings['Group C'][1] },
            { seed: 7, ...standings['Group A'][2] },
            { seed: 8, ...standings['Group B'][2] }
        ];

        const playoffMatches = {
            qf: [
                { id: 'qf_1', roundName: 'רבע גמר 1', seed1: 1, seed2: 8, team1: playoffSeeds[0], team2: playoffSeeds[7], score1: 88, score2: 78, winner: 'team1', nextMatchId: 'sf_1', nextSlot: 1 },
                { id: 'qf_2', roundName: 'רבע גמר 2', seed1: 4, seed2: 5, team1: playoffSeeds[3], team2: playoffSeeds[4], score1: 82, score2: 80, winner: 'team1', nextMatchId: 'sf_1', nextSlot: 2 },
                { id: 'qf_3', roundName: 'רבע גמר 3', seed1: 3, seed2: 6, team1: playoffSeeds[2], team2: playoffSeeds[5], score1: 91, score2: 85, winner: 'team1', nextMatchId: 'sf_2', nextSlot: 1 },
                { id: 'qf_4', roundName: 'רבע גמר 4', seed1: 2, seed2: 7, team1: playoffSeeds[1], team2: playoffSeeds[6], score1: 89, score2: 83, winner: 'team1', nextMatchId: 'sf_2', nextSlot: 2 }
            ],
            sf: [
                { id: 'sf_1', roundName: 'חצי גמר 1', team1: playoffSeeds[0], team2: playoffSeeds[3], score1: 94, score2: 88, winner: 'team1', nextMatchId: 'final', nextSlot: 1 },
                { id: 'sf_2', roundName: 'חצי גמר 2', team1: playoffSeeds[2], team2: playoffSeeds[1], score1: 85, score2: 90, winner: 'team2', nextMatchId: 'final', nextSlot: 2 }
            ],
            final: {
                id: 'final', roundName: '🏆 משחק הגמר', team1: playoffSeeds[0], team2: playoffSeeds[1], score1: 92, score2: 87, winner: 'team1'
            }
        };

        return {
            id: 'tourney_archive_2025',
            name: 'טורניר עונת 2025 (ארכיון תוצאות)',
            createdAt: '2025-10-15',
            isArchived: true,
            teams,
            groups,
            matches,
            standings,
            playoffSeeds,
            playoffMatches
        };
    }

    populateTournamentSelectors() {
        const loginSelect = document.getElementById('loginTournamentSelect');
        const signupSelect = document.getElementById('signupTournamentSelect');
        const headerSelect = document.getElementById('headerTournamentSelect');
        const pickerGroup = document.getElementById('loginTournamentPickerGroup');

        // אם יש רק טורניר אחד, מסתירים את הבחירה בלוגין לפי דרישת המשתמש
        if (pickerGroup) {
            pickerGroup.style.display = (this.tournaments.length <= 1) ? 'none' : 'block';
        }

        const optionsHtml = this.tournaments.map(t => `
            <option value="${t.id}" ${t.id === this.activeTournamentId ? 'selected' : ''}>
                ${t.name} ${t.isArchived ? '(ארכיון)' : '⚡'}
            </option>
        `).join('');

        if (loginSelect) loginSelect.innerHTML = optionsHtml;
        if (signupSelect) signupSelect.innerHTML = optionsHtml;
        if (headerSelect) headerSelect.innerHTML = optionsHtml;

        // עדכון תג שם הטורניר עבור אורח
        this.updateGuestTournamentBadge();

        // סנכרון מיידי של שדות הבית והקבוצה במסך הכניסה
        const currentLoginTourneyId = loginSelect && loginSelect.value ? loginSelect.value : this.activeTournamentId;
        this.updateLoginHousesAndTeams(currentLoginTourneyId);
    }

    onLoginTournamentChange(tourneyId) {
        this.updateLoginHousesAndTeams(tourneyId);
    }

    onLoginHouseChange() {
        const tourneySelect = document.getElementById('loginTournamentSelect');
        const tourneyId = tourneySelect && tourneySelect.value ? tourneySelect.value : this.activeTournamentId;
        this.updateLoginTeams(tourneyId);
    }

    updateLoginHousesAndTeams(selectedTourneyId) {
        const tourneyId = selectedTourneyId || document.getElementById('loginTournamentSelect')?.value || this.activeTournamentId;
        const tourney = this.tournaments.find(t => t.id === tourneyId) || this.tournaments[0];
        if (!tourney) return;

        const houseGroup = document.getElementById('loginHouseGroup');
        const houseSelect = document.getElementById('loginHouseSelect');

        const groupHebrewMap = {
            'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
            'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
        };

        // אם הטורניר הוא נוקאאוט בלבד, לא שואלים על בתים כלל
        if (tourney.format === 'knockout_only') {
            if (houseGroup) houseGroup.classList.add('hidden');
        } else {
            // אם הטורניר כולל בתים
            if (houseGroup) houseGroup.classList.remove('hidden');
            if (houseSelect) {
                let groupKeys = (tourney.groups && Object.keys(tourney.groups).length > 0)
                    ? Object.keys(tourney.groups)
                    : [];

                if (groupKeys.length === 0) {
                    const n = tourney.numGroups || 3;
                    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                    groupKeys = letters.slice(0, n).map(l => `Group ${l}`);
                }

                houseSelect.innerHTML = `
                    <option value="all">כל הבתים (ללא סינון בית)</option>
                    ${groupKeys.map(k => `
                        <option value="${k}">${groupHebrewMap[k] || k}</option>
                    `).join('')}
                `;
            }
        }

        this.updateLoginTeams(tourneyId);
    }

    updateLoginTeams(selectedTourneyId) {
        const tourneyId = selectedTourneyId || document.getElementById('loginTournamentSelect')?.value || this.activeTournamentId;
        const tourney = this.tournaments.find(t => t.id === tourneyId) || this.tournaments[0];
        const teamGroup = document.getElementById('loginTeamGroup');
        const teamSelect = document.getElementById('loginTeamSelect');
        const houseSelect = document.getElementById('loginHouseSelect');
        if (!teamSelect || !tourney) return;

        if (teamGroup) teamGroup.classList.remove('hidden');

        const selectedHouse = houseSelect ? houseSelect.value : 'all';
        let teamsToDisplay = [];

        if (tourney.groups && selectedHouse !== 'all' && tourney.groups[selectedHouse]) {
            teamsToDisplay = tourney.groups[selectedHouse].map(t => t.name || t);
        } else if (tourney.teams && tourney.teams.length > 0) {
            teamsToDisplay = [...tourney.teams];
        } else {
            teamsToDisplay = [...this.defaultTeams];
        }

        teamSelect.innerHTML = `
            <option value="">ללא קבוצה מועדפת (הצג הכל כרגיל)</option>
            ${teamsToDisplay.map(name => `
                <option value="${name}">⚽ ${name}</option>
            `).join('')}
        `;
    }

    loadTournamentData(tourneyId) {
        let tData = this.tournaments.find(t => t.id === tourneyId);
        if (!tData) {
            tData = this.tournaments[0];
            this.activeTournamentId = tData.id;
        }

        this.format = tData.format || 'groups_and_playoff';
        this.numGroups = parseInt(tData.numGroups, 10) || (tData.groups ? Object.keys(tData.groups).length : 2);
        this.teamsPerGroup = parseInt(tData.teamsPerGroup, 10) || 4;
        this.playoffSize = parseInt(tData.playoffSize, 10) || (this.numGroups * this.teamsPerGroup >= 8 ? 8 : 4);
        this.pointsPerWin = (tData.pointsPerWin !== undefined) ? parseInt(tData.pointsPerWin, 10) : 3;
        this.pointsPerDraw = (tData.pointsPerDraw !== undefined) ? parseInt(tData.pointsPerDraw, 10) : 1;
        this.teams = tData.teams ? [...tData.teams] : [...this.defaultTeams];

        // בדיקה וסנכרון תקינות של מבנה הבתים והמשחקים (מניעת ערבוב בתים שאינם קיימים)
        if (this.format !== 'knockout_only') {
            const groupLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
            const allowedKeys = groupLetters.slice(0, this.numGroups).map(l => `Group ${l}`);
            const totalExpectedTeams = this.numGroups * this.teamsPerGroup;

            // התאמת כמות הקבוצות במערך הקבוצות בדיוק למספר הבתים והקבוצות
            if (this.teams.length < totalExpectedTeams) {
                while (this.teams.length < totalExpectedTeams) {
                    this.teams.push(`קבוצה ${this.teams.length + 1}`);
                }
            } else if (this.teams.length > totalExpectedTeams) {
                this.teams = this.teams.slice(0, totalExpectedTeams);
            }

            // סילוק בתים עודפים שנותרו בעבר (למשל בית ג' כשעוברים ל-2 בתים)
            if (tData.groups && typeof tData.groups === 'object') {
                Object.keys(tData.groups).forEach(k => {
                    if (!allowedKeys.includes(k)) delete tData.groups[k];
                });
            }
            if (tData.standings && typeof tData.standings === 'object') {
                Object.keys(tData.standings).forEach(k => {
                    if (!allowedKeys.includes(k)) delete tData.standings[k];
                });
            }
            if (Array.isArray(tData.matches)) {
                tData.matches = tData.matches.filter(m => 
                    allowedKeys.includes(m.groupId) &&
                    m.team1Index < this.teams.length &&
                    m.team2Index < this.teams.length
                );
            }

            const currentGroupKeys = tData.groups ? Object.keys(tData.groups) : [];
            const matchesPerGroup = (this.teamsPerGroup * (this.teamsPerGroup - 1)) / 2;
            const expectedTotalMatches = this.numGroups * matchesPerGroup;

            // אם כמות הבתים או המשחקים אינה תואמת במדויק את המבנה החדש, נאפס אותם כדי שייבנו מחדש בצורה נקייה
            if (currentGroupKeys.length !== this.numGroups || !tData.matches || tData.matches.length !== expectedTotalMatches) {
                tData.groups = null;
                tData.matches = null;
                tData.standings = null;
            }
        }

        const knockoutNotice = document.getElementById('group-knockout-notice');
        const groupMainContent = document.getElementById('group-stage-main-content');
        const seedPlayoffsBtns = document.querySelectorAll('.btn-seed-playoffs-action');
        const playoffGroupsOnlyNotice = document.getElementById('playoff-groups-only-notice');
        const playoffMainContent = document.getElementById('playoff-main-content');

        if (this.format === 'knockout_only') {
            if (knockoutNotice) knockoutNotice.classList.remove('hidden');
            if (groupMainContent) groupMainContent.classList.add('hidden');
            if (playoffGroupsOnlyNotice) playoffGroupsOnlyNotice.classList.add('hidden');
            if (playoffMainContent) playoffMainContent.classList.remove('hidden');
            seedPlayoffsBtns.forEach(btn => btn.classList.add('hidden'));

            this.groups = {};
            this.matches = [];
            this.standings = {};
            this.playoffSeeds = tData.playoffSeeds || [];
            this.playoffMatches = tData.playoffMatches || this.buildInitialKnockoutBracket(this.playoffSeeds, this.teams.length);

            this.renderTeamInputs();
            this.renderPlayoffBracket();
        } else if (this.format === 'groups_only') {
            if (knockoutNotice) knockoutNotice.classList.add('hidden');
            if (groupMainContent) groupMainContent.classList.remove('hidden');
            seedPlayoffsBtns.forEach(btn => btn.classList.add('hidden'));
            if (playoffGroupsOnlyNotice) playoffGroupsOnlyNotice.classList.remove('hidden');
            if (playoffMainContent) playoffMainContent.classList.add('hidden');

            if (tData.matches && tData.matches.length > 0) {
                this.groups = tData.groups || {};
                this.matches = tData.matches || [];
                this.standings = tData.standings || {};
                this.playoffSeeds = [];
                this.playoffMatches = null;
                this.renderTeamInputs();
                this.renderMatches();
                this.renderStandings();
            } else {
                this.renderTeamInputs();
                this.generateTournamentGroups(false);
            }
        } else {
            // groups_and_playoff
            if (knockoutNotice) knockoutNotice.classList.add('hidden');
            if (groupMainContent) groupMainContent.classList.remove('hidden');
            seedPlayoffsBtns.forEach(btn => btn.classList.remove('hidden'));
            if (playoffGroupsOnlyNotice) playoffGroupsOnlyNotice.classList.add('hidden');
            if (playoffMainContent) playoffMainContent.classList.remove('hidden');

            if (tData.matches && tData.matches.length > 0) {
                this.groups = tData.groups || {};
                this.matches = tData.matches || [];
                this.standings = tData.standings || {};
                this.playoffSeeds = tData.playoffSeeds || [];
                this.playoffMatches = tData.playoffMatches || this.createEmptyPlayoffMatches(this.playoffSize);
                this.renderTeamInputs();
                this.renderMatches();
                this.renderStandings();
                if (this.playoffSeeds.length > 0) {
                    this.renderPlayoffBracket();
                }
            } else {
                this.renderTeamInputs();
                this.generateTournamentGroups(false);
            }
        }

        // עדכון באנר הארכיון
        this.updateArchiveBannerUI();

        // סנכרון תפריטים
        this.populateTournamentSelectors();
        this.switchRole(this.currentRole);
        this.updateCloseButtonUI();
    }

    updateArchiveBannerUI() {
        const archiveBanner = document.getElementById('archiveBanner');
        if (!archiveBanner) return;

        const isClosed = this.isCurrentTournamentClosed();
        if (isClosed) {
            archiveBanner.classList.remove('hidden');
            const switchBtn = document.getElementById('btnSwitchToActiveTourney');
            if (switchBtn) {
                const activeTourney = this.tournaments.find(t => !t.isArchived);
                if (activeTourney) {
                    switchBtn.disabled = false;
                    switchBtn.style.opacity = '1';
                    switchBtn.style.cursor = 'pointer';
                    switchBtn.title = `מעבר לטורניר הפעיל: ${activeTourney.name}`;
                } else {
                    // אין טורניר פעיל כרגע במערכת - הכפתור מושבת לפי דרישת המשתמש
                    switchBtn.disabled = true;
                    switchBtn.style.opacity = '0.45';
                    switchBtn.style.cursor = 'not-allowed';
                    switchBtn.title = 'אין כרגע טורניר פעיל במערכת (כל הטורנירים סגורים)';
                }
            }
        } else {
            archiveBanner.classList.add('hidden');
        }
    }

    saveActiveTournamentData() {
        const idx = this.tournaments.findIndex(t => t.id === this.activeTournamentId);
        if (idx !== -1) {
            this.tournaments[idx].format = this.format;
            this.tournaments[idx].numGroups = this.numGroups;
            this.tournaments[idx].teamsPerGroup = this.teamsPerGroup;
            this.tournaments[idx].playoffSize = this.playoffSize;
            this.tournaments[idx].pointsPerWin = this.pointsPerWin;
            this.tournaments[idx].pointsPerDraw = this.pointsPerDraw;
            this.tournaments[idx].teams = [...this.teams];
            this.tournaments[idx].groups = this.groups;
            this.tournaments[idx].matches = this.matches;
            this.tournaments[idx].standings = this.standings;
            this.tournaments[idx].playoffSeeds = this.playoffSeeds;
            this.tournaments[idx].playoffMatches = this.playoffMatches;
            this.saveTournamentsList();
        }
    }

    switchTournament(newTourneyId, showNotification = true) {
        if (newTourneyId === this.activeTournamentId) return;
        this.openPlayoffMatchId = null;

        // אורח/צופה מחובר אינו רשאי לעבור לטורניר אחר
        if (this.currentRole === 'viewer') {
            this.showAlert("כמשתמש אורח, הגישה מוגבלת לטורניר הנבחר בלבד.", "warning");
            return;
        }

        this.saveActiveTournamentData();
        this.activeTournamentId = newTourneyId;
        this.loadTournamentData(newTourneyId);

        const tourney = this.tournaments.find(t => t.id === newTourneyId);
        if (showNotification && tourney) {
            if (tourney.isArchived) {
                this.showAlert(`עברת לצפייה ב-${tourney.name} (ארכיון).`, "warning");
            } else {
                this.showAlert(`עברת ל-${tourney.name}.`, "success");
            }
        }
    }

    switchToActiveTournament() {
        const active = this.tournaments.find(t => !t.isArchived);
        if (active) {
            this.switchTournament(active.id);
        } else {
            this.showAlert("אין טורניר פעיל כרגע במערכת (כל הטורנירים סגורים).", "warning");
        }
    }

    createNewTournament() {
        this.openTournamentWizard();
    }

    /* ========================================================
       אשף פתיחת ועריכת טורניר דינמי (Dynamic Tournament Wizard)
       ======================================================== */

    openTournamentWizard(isEdit = false, targetTourneyId = null) {
        if (this.currentRole !== 'owner' && this.currentRole !== 'admin') {
            this.showAlert("רק מנהל (Admin) או Owner רשאים להקים או לערוך טורניר!", "error");
            return;
        }

        this.wizardMode = isEdit ? 'edit' : 'create';
        this.wizardEditingTourneyId = isEdit ? (targetTourneyId || this.activeTournamentId) : null;

        const modal = document.getElementById('new-tournament-wizard-modal');
        const modalTitle = document.getElementById('wizardModalTitle');
        const modalSub = document.getElementById('wizardModalSubtitle');
        const submitBtn = document.getElementById('wizardSubmitBtn');
        const nameInp = document.getElementById('wizardTourneyName');
        const numGroupsSelect = document.getElementById('wizardNumGroups');
        const teamsPerGroupSelect = document.getElementById('wizardTeamsPerGroup');
        const playoffSizeSelect = document.getElementById('wizardPlayoffSize');
        const knockoutTeamsSelect = document.getElementById('wizardKnockoutTeams');
        const pointsWinInp = document.getElementById('wizardPointsWin');
        const pointsDrawInp = document.getElementById('wizardPointsDraw');
        const formatRadios = document.querySelectorAll('input[name="wizardFormat"]');

        if (isEdit) {
            const tourney = this.tournaments.find(t => t.id === this.wizardEditingTourneyId) || this.tournaments.find(t => t.id === this.activeTournamentId);
            if (!tourney) return;

            if (tourney.isArchived) {
                this.showAlert("הטורניר סגור ונעול לעריכה. לפתיחתו יש ללחוץ על 'פתח טורניר מחדש'.", "warning");
                return;
            }

            if (modalTitle) modalTitle.innerHTML = `⚙️ עריכת טורניר: ${tourney.name}`;
            if (modalSub) modalSub.innerHTML = `ניתן לעדכן את שם הטורניר ושיטת הניקוד.<br><span style="color:#b45309; font-weight:700;">🔒 מבנה הטורניר (כמות הקבוצות, הבתים והפלייאוף) נעול לשינויים כדי לשמור על תקינות לוח המשחקים.</span> שמות הקבוצות ניתנים לעריכה במסך "קבוצות". במידה ודרוש מבנה חדש, יש לפתוח טורניר חדש באשף.`;
            if (submitBtn) submitBtn.innerHTML = `💾 שמור שינויים`;

            if (nameInp) nameInp.value = tourney.name;
            const fmt = tourney.format || 'groups_and_playoff';
            const rad = document.querySelector(`input[name="wizardFormat"][value="${fmt}"]`);
            if (rad) rad.checked = true;

            // נעילת שדות מבנה בעריכת טורניר קיים
            formatRadios.forEach(r => r.disabled = true);
            if (numGroupsSelect) {
                numGroupsSelect.value = String(tourney.numGroups || 3);
                numGroupsSelect.disabled = true;
            }
            if (teamsPerGroupSelect) {
                teamsPerGroupSelect.value = String(tourney.teamsPerGroup || 5);
                teamsPerGroupSelect.disabled = true;
            }
            if (playoffSizeSelect) {
                playoffSizeSelect.value = String(tourney.playoffSize || 8);
                playoffSizeSelect.disabled = true;
            }
            if (knockoutTeamsSelect) {
                knockoutTeamsSelect.value = String(tourney.teams?.length || 8);
                knockoutTeamsSelect.disabled = true;
            }
            if (pointsWinInp) pointsWinInp.value = String(tourney.pointsPerWin !== undefined ? tourney.pointsPerWin : 3);
            if (pointsDrawInp) pointsDrawInp.value = String(tourney.pointsPerDraw !== undefined ? tourney.pointsPerDraw : 1);
        } else {
            if (modalTitle) modalTitle.innerHTML = `✨ אשף הקמת טורניר חדש`;
            if (modalSub) modalSub.textContent = `הגדר את מבנה הטורניר באופן דינמי: שלב בתים בלבד (ליגה), בתים משולב פלייאוף, או נוקאאוט ישיר, עם שליטה מלאה על שיטת הניקוד והדירוג.`;
            if (submitBtn) submitBtn.innerHTML = `🚀 צור טורניר והפעל לוח משחקים`;

            if (nameInp) nameInp.value = `טורניר חדש ${new Date().toLocaleDateString('he-IL')}`;
            const rad = document.querySelector('input[name="wizardFormat"][value="groups_and_playoff"]');
            if (rad) rad.checked = true;

            // שחרור שדות מבנה להקמת טורניר חדש
            formatRadios.forEach(r => r.disabled = false);
            if (numGroupsSelect) {
                numGroupsSelect.value = '3';
                numGroupsSelect.disabled = false;
            }
            if (teamsPerGroupSelect) {
                teamsPerGroupSelect.value = '5';
                teamsPerGroupSelect.disabled = false;
            }
            if (playoffSizeSelect) {
                playoffSizeSelect.value = '8';
                playoffSizeSelect.disabled = false;
            }
            if (knockoutTeamsSelect) {
                knockoutTeamsSelect.value = '8';
                knockoutTeamsSelect.disabled = false;
            }
            if (pointsWinInp) pointsWinInp.value = '3';
            if (pointsDrawInp) pointsDrawInp.value = '1';
        }

        this.updateWizardPlayoffOptions();
        this.onWizardFormatChange();
        this.updateWizardSummary();

        if (modal) modal.classList.remove('hidden');
    }

    openEditTournamentModal(tourneyId = null) {
        const targetId = tourneyId || this.activeTournamentId;
        const tourney = this.tournaments.find(t => t.id === targetId);
        if (tourney && tourney.isArchived) {
            this.showAlert("הטורניר סגור ונעול לעריכה. לפתיחתו יש ללחוץ על 'פתח טורניר מחדש'.", "warning");
            return;
        }
        this.openTournamentWizard(true, targetId);
    }

    closeTournamentWizard() {
        const modal = document.getElementById('new-tournament-wizard-modal');
        if (modal) modal.classList.add('hidden');
    }

    onWizardGroupsOrTeamsChange() {
        this.updateWizardPlayoffOptions();
        this.updateWizardSummary();
    }

    updateWizardPlayoffOptions() {
        const numGroups = parseInt(document.getElementById('wizardNumGroups')?.value || '3', 10);
        const teamsPerGroup = parseInt(document.getElementById('wizardTeamsPerGroup')?.value || '5', 10);
        const totalTeams = numGroups * teamsPerGroup;
        const playoffSelect = document.getElementById('wizardPlayoffSize');
        if (!playoffSelect) return;

        let currentValue = parseInt(playoffSelect.value || '8', 10);
        let validOptions = [];

        Array.from(playoffSelect.options).forEach(opt => {
            const val = parseInt(opt.value, 10);
            if (val > totalTeams) {
                opt.disabled = true;
                opt.hidden = true;
            } else {
                opt.disabled = false;
                opt.hidden = false;
                validOptions.push(val);
            }
        });

        // אם הערך שנבחר כרגע גבוה מסך הקבוצות, בחירה אוטומטית של האפשרות הגבוהה ביותר המותרת
        if (currentValue > totalTeams || !validOptions.includes(currentValue)) {
            if (validOptions.length > 0) {
                const maxValid = Math.max(...validOptions);
                playoffSelect.value = String(maxValid);
            }
        }
    }

    onWizardFormatChange() {
        const radFormat = document.querySelector('input[name="wizardFormat"]:checked');
        const format = radFormat ? radFormat.value : 'groups_and_playoff';

        const cardGroups = document.getElementById('cardFormatGroups');
        const cardGroupsOnly = document.getElementById('cardFormatGroupsOnly');
        const cardKnockout = document.getElementById('cardFormatKnockout');
        const boxGroups = document.getElementById('wizardGroupsSettings');
        const boxKnockout = document.getElementById('wizardKnockoutSettings');
        const playoffSizeGroup = document.getElementById('wizardPlayoffSizeGroup');

        if (cardGroups) cardGroups.classList.toggle('active', format === 'groups_and_playoff');
        if (cardGroupsOnly) cardGroupsOnly.classList.toggle('active', format === 'groups_only');
        if (cardKnockout) cardKnockout.classList.toggle('active', format === 'knockout_only');

        if (format === 'knockout_only') {
            if (boxGroups) boxGroups.classList.add('hidden');
            if (boxKnockout) boxKnockout.classList.remove('hidden');
        } else if (format === 'groups_only') {
            if (boxGroups) boxGroups.classList.remove('hidden');
            if (boxKnockout) boxKnockout.classList.add('hidden');
            if (playoffSizeGroup) playoffSizeGroup.classList.add('hidden');
        } else {
            // groups_and_playoff
            if (boxGroups) boxGroups.classList.remove('hidden');
            if (boxKnockout) boxKnockout.classList.add('hidden');
            if (playoffSizeGroup) playoffSizeGroup.classList.remove('hidden');
            this.updateWizardPlayoffOptions();
        }

        this.updateWizardSummary();
    }

    updateWizardSummary() {
        const radFormat = document.querySelector('input[name="wizardFormat"]:checked');
        const format = radFormat ? radFormat.value : 'groups_and_playoff';
        const summaryBox = document.getElementById('wizardSummaryBox');
        if (!summaryBox) return;

        const pointsWin = parseInt(document.getElementById('wizardPointsWin')?.value || '3', 10);
        const pointsDraw = parseInt(document.getElementById('wizardPointsDraw')?.value || '1', 10);

        if (format === 'groups_only') {
            const numGroups = parseInt(document.getElementById('wizardNumGroups')?.value || '3', 10);
            const teamsPerGroup = parseInt(document.getElementById('wizardTeamsPerGroup')?.value || '5', 10);
            const totalTeams = numGroups * teamsPerGroup;
            const matchesPerGroup = (teamsPerGroup * (teamsPerGroup - 1)) / 2;
            const totalGroupMatches = numGroups * matchesPerGroup;

            summaryBox.innerHTML = `
                📊 <strong>סיכום מבנה הטורניר:</strong> <bdi>${totalTeams}</bdi> קבוצות (<bdi>${numGroups}</bdi> בתים של <bdi>${teamsPerGroup}</bdi> קבוצות) | 
                ⚽ <bdi>${totalGroupMatches}</bdi> משחקים (ללא פלייאוף) | 
                🥇 <bdi>${pointsWin}</bdi> נק' לניצחון, 🤝 <bdi>${pointsDraw}</bdi> נק' לתיקו (הדירוג והאלופה נקבעים לפי נקודות והפרש שערים)
            `;
        } else if (format === 'groups_and_playoff') {
            const numGroups = parseInt(document.getElementById('wizardNumGroups')?.value || '3', 10);
            const teamsPerGroup = parseInt(document.getElementById('wizardTeamsPerGroup')?.value || '5', 10);
            const playoffSize = parseInt(document.getElementById('wizardPlayoffSize')?.value || '8', 10);
            const totalTeams = numGroups * teamsPerGroup;
            const matchesPerGroup = (teamsPerGroup * (teamsPerGroup - 1)) / 2;
            const totalGroupMatches = numGroups * matchesPerGroup;

            const playoffDesc = (playoffSize === 2) ? 'משחק גמר בלבד' :
                                (playoffSize === 4) ? 'חצי גמר וגמר' :
                                (playoffSize === 8) ? 'רבע גמר, חצי גמר וגמר' : 'שמינית, רבע, חצי וגמר';

            summaryBox.innerHTML = `
                📊 <strong>סיכום מבנה הטורניר:</strong> <bdi>${totalTeams}</bdi> קבוצות (<bdi>${numGroups}</bdi> בתים של <bdi>${teamsPerGroup}</bdi> קבוצות) | 
                ⚽ <bdi>${totalGroupMatches}</bdi> משחקים בשלב הבתים | 
                🌳 <bdi>${playoffSize}</bdi> עולות לפלייאוף (${playoffDesc}) | 
                🥇 <bdi>${pointsWin}</bdi> נק' לניצחון, 🤝 <bdi>${pointsDraw}</bdi> לתיקו
            `;
        } else {
            const totalTeams = parseInt(document.getElementById('wizardKnockoutTeams')?.value || '8', 10);
            const totalMatches = totalTeams - 1;
            const roundStart = (totalTeams === 2) ? 'משחק גמר ישיר' :
                               (totalTeams === 4) ? 'חצי גמר' :
                               (totalTeams === 8) ? 'רבע גמר' : 'שמינית גמר';
            summaryBox.innerHTML = `
                ⚔️ <strong>סיכום מבנה הטורניר:</strong> נוקאאוט ישיר ל-<bdi>${totalTeams}</bdi> קבוצות (ללא שלב בתים) | 
                סה"כ <bdi>${totalMatches}</bdi> משחקי נוקאאוט עד להכרעת האלופה (מתחיל מ-${roundStart})
            `;
        }
    }

    submitTournamentWizard() {
        if (this.currentRole !== 'owner' && this.currentRole !== 'admin') {
            this.showAlert("רק מנהל (Admin) או Owner רשאים להקים או לערוך טורניר!", "error");
            return;
        }

        const isEdit = (this.wizardMode === 'edit');
        const targetId = isEdit ? (this.wizardEditingTourneyId || this.activeTournamentId) : `tourney_${Date.now()}`;
        const existingTourney = isEdit ? this.tournaments.find(t => t.id === targetId) : null;

        const nameInp = document.getElementById('wizardTourneyName');
        const tourneyName = (nameInp && nameInp.value.trim()) ? nameInp.value.trim() : `טורניר ${new Date().toLocaleDateString('he-IL')}`;
        const pointsPerWin = parseInt(document.getElementById('wizardPointsWin')?.value || '3', 10);
        const pointsPerDraw = parseInt(document.getElementById('wizardPointsDraw')?.value || '1', 10);

        if (isEdit && existingTourney) {
            // בעריכת טורניר קיים: לא משנים מבנה ולא מוסיפים/מוחקים קבוצות!
            // מעדכנים רק שם ושיטת ניקוד
            existingTourney.name = tourneyName;
            existingTourney.pointsPerWin = pointsPerWin;
            existingTourney.pointsPerDraw = pointsPerDraw;

            if (this.activeTournamentId === targetId) {
                this.pointsPerWin = pointsPerWin;
                this.pointsPerDraw = pointsPerDraw;
                this.calculateStandings();
                this.saveActiveTournamentData();
            }

            this.saveTournamentsList();
            this.closeTournamentWizard();
            this.populateTournamentSelectors();
            this.renderOwnerTournamentsList();
            this.updateGuestTournamentBadge();
            this.showAlert(`פרטי הטורניר '${tourneyName}' עודכנו בהצלחה!`, "success");
            return;
        }

        // הקמת טורניר חדש בלבד:
        const radFormat = document.querySelector('input[name="wizardFormat"]:checked');
        const format = radFormat ? radFormat.value : 'groups_and_playoff';

        let totalTeams = 0;
        let numGroups = 0;
        let teamsPerGroup = 0;
        let playoffSize = 0;

        if (format === 'knockout_only') {
            totalTeams = parseInt(document.getElementById('wizardKnockoutTeams')?.value || '8', 10);
            playoffSize = totalTeams;
        } else {
            numGroups = parseInt(document.getElementById('wizardNumGroups')?.value || '3', 10);
            teamsPerGroup = parseInt(document.getElementById('wizardTeamsPerGroup')?.value || '5', 10);
            totalTeams = numGroups * teamsPerGroup;
            playoffSize = (format === 'groups_only') ? 0 : parseInt(document.getElementById('wizardPlayoffSize')?.value || '8', 10);

            // בדיקת תקינות: מספר העולות לפלייאוף לא יעלה על כמות הקבוצות הכוללת בבתים!
            if (format === 'groups_and_playoff' && playoffSize > totalTeams) {
                this.showAlert(`לא ניתן לבחור פלייאוף של ${playoffSize} קבוצות כאשר בשלב הבתים יש רק ${totalTeams} קבוצות! יש לבחור לכל היותר ${totalTeams} עולות.`, "error");
                return;
            }
        }

        // שימור שמות קבוצות ברירת מחדל
        const teams = [];
        for (let i = 0; i < totalTeams; i++) {
            if (i < this.defaultTeams.length) {
                teams.push(this.defaultTeams[i]);
            } else {
                teams.push(`קבוצה ${i + 1}`);
            }
        }

        let groups = {};
        let standings = {};
        let matches = [];
        let playoffSeeds = [];
        let playoffMatches = null;

        if (format === 'knockout_only') {
            playoffSeeds = teams.map((name, i) => ({
                seed: i + 1,
                teamIndex: i,
                teamName: name,
                origin: `מדורגת #${i + 1}`,
                wins: 0, pointDiff: 0, pts: 0
            }));
            playoffMatches = this.buildInitialKnockoutBracket(playoffSeeds, totalTeams);
        } else {
            const groupLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
            for (let g = 0; g < numGroups; g++) {
                const grpKey = `Group ${groupLetters[g]}`;
                const startIndex = g * teamsPerGroup;
                const grpTeams = [];
                for (let t = 0; t < teamsPerGroup; t++) {
                    const idx = startIndex + t;
                    grpTeams.push({ index: idx, name: teams[idx], group: grpKey });
                }
                groups[grpKey] = grpTeams;
                standings[grpKey] = grpTeams.map(item => ({
                    teamIndex: item.index,
                    teamName: teams[item.index],
                    group: grpKey,
                    played: 0, wins: 0, draws: 0, losses: 0,
                    pointsFor: 0, pointsAgainst: 0, pointDiff: 0,
                    pts: 0, groupRank: 0
                }));
            }
            matches = this.generateDynamicRoundRobin(groups, teams, teamsPerGroup);
            if (format === 'groups_and_playoff') {
                playoffMatches = this.createEmptyPlayoffMatches(playoffSize);
            }
        }

        let tournamentObj = {
            id: targetId,
            name: tourneyName,
            format,
            numGroups,
            teamsPerGroup,
            playoffSize,
            pointsPerWin,
            pointsPerDraw,
            createdAt: new Date().toLocaleDateString('he-IL'),
            isArchived: false,
            teams,
            groups,
            matches,
            standings,
            playoffSeeds,
            playoffMatches
        };

        this.saveActiveTournamentData();
        this.tournaments.unshift(tournamentObj);
        this.saveTournamentsList();
        this.closeTournamentWizard();
        this.activeTournamentId = targetId;
        this.loadTournamentData(targetId);
        this.populateTournamentSelectors();
        this.renderOwnerTournamentsList();

        if (format === 'knockout_only') {
            this.switchTab('playoffs');
        } else {
            this.switchTab('setup');
        }

        this.showAlert(`הטורניר '${tourneyName}' הוקם בהצלחה עם ${teams.length} קבוצות!`, "success");
    }

    generateDynamicRoundRobin(groups, teams, teamsPerGroup) {
        const groupHebrew = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'"];
        const matches = [];
        let matchCounter = 1;

        const isOdd = teamsPerGroup % 2 !== 0;
        const n = isOdd ? teamsPerGroup + 1 : teamsPerGroup;
        const totalRounds = n - 1;
        const half = n / 2;

        Object.keys(groups).forEach((grpKey, gIdx) => {
            const grpNameHe = `בית ${groupHebrew[gIdx] || (gIdx + 1)}`;
            const grpTeams = groups[grpKey];

            let circle = [];
            for (let i = 0; i < teamsPerGroup; i++) circle.push(i);
            if (isOdd) circle.push(-1);

            for (let round = 1; round <= totalRounds; round++) {
                for (let i = 0; i < half; i++) {
                    const local1 = circle[i];
                    const local2 = circle[n - 1 - i];

                    if (local1 !== -1 && local2 !== -1) {
                        const t1Idx = grpTeams[local1].index;
                        const t2Idx = grpTeams[local2].index;

                        matches.push({
                            id: `match_${matchCounter}`,
                            matchNumber: matchCounter,
                            groupId: grpKey,
                            groupNameHe: grpNameHe,
                            round: round,
                            team1Index: t1Idx,
                            team2Index: t2Idx,
                            team1Name: teams[t1Idx],
                            team2Name: teams[t2Idx],
                            score1: null,
                            score2: null,
                            winner: null
                        });
                        matchCounter++;
                    }
                }

                const last = circle.pop();
                circle.splice(1, 0, last);
            }
        });

        return matches;
    }

    buildInitialKnockoutBracket(playoffSeeds, totalTeams) {
        const getSeed = (num) => playoffSeeds.find(s => s.seed === num) || null;

        if (totalTeams === 2) {
            return {
                final: {
                    id: 'final', roundName: '🏆 משחק הגמר',
                    seed1: 1, seed2: 2,
                    team1: getSeed(1), team2: getSeed(2),
                    score1: null, score2: null, winner: null
                }
            };
        }

        if (totalTeams === 4) {
            return {
                sf: [
                    {
                        id: 'sf_1', roundName: 'חצי גמר 1 (1v4)',
                        seed1: 1, seed2: 4,
                        team1: getSeed(1), team2: getSeed(4),
                        score1: null, score2: null, winner: null,
                        nextMatchId: 'final', nextSlot: 1
                    },
                    {
                        id: 'sf_2', roundName: 'חצי גמר 2 (2v3)',
                        seed1: 2, seed2: 3,
                        team1: getSeed(2), team2: getSeed(3),
                        score1: null, score2: null, winner: null,
                        nextMatchId: 'final', nextSlot: 2
                    }
                ],
                final: {
                    id: 'final', roundName: '🏆 משחק הגמר',
                    team1: null, team2: null,
                    score1: null, score2: null, winner: null
                }
            };
        }

        if (totalTeams === 16) {
            return {
                r16: [
                    { id: 'r16_1', roundName: 'שמינית גמר 1', seed1: 1, seed2: 16, team1: getSeed(1), team2: getSeed(16), score1: null, score2: null, winner: null, nextMatchId: 'qf_1', nextSlot: 1 },
                    { id: 'r16_2', roundName: 'שמינית גמר 2', seed1: 8, seed2: 9, team1: getSeed(8), team2: getSeed(9), score1: null, score2: null, winner: null, nextMatchId: 'qf_1', nextSlot: 2 },
                    { id: 'r16_3', roundName: 'שמינית גמר 3', seed1: 4, seed2: 13, team1: getSeed(4), team2: getSeed(13), score1: null, score2: null, winner: null, nextMatchId: 'qf_2', nextSlot: 1 },
                    { id: 'r16_4', roundName: 'שמינית גמר 4', seed1: 5, seed2: 12, team1: getSeed(5), team2: getSeed(12), score1: null, score2: null, winner: null, nextMatchId: 'qf_2', nextSlot: 2 },
                    { id: 'r16_5', roundName: 'שמינית גמר 5', seed1: 2, seed2: 15, team1: getSeed(2), team2: getSeed(15), score1: null, score2: null, winner: null, nextMatchId: 'qf_3', nextSlot: 1 },
                    { id: 'r16_6', roundName: 'שמינית גמר 6', seed1: 7, seed2: 10, team1: getSeed(7), team2: getSeed(10), score1: null, score2: null, winner: null, nextMatchId: 'qf_3', nextSlot: 2 },
                    { id: 'r16_7', roundName: 'שמינית גמר 7', seed1: 3, seed2: 14, team1: getSeed(3), team2: getSeed(14), score1: null, score2: null, winner: null, nextMatchId: 'qf_4', nextSlot: 1 },
                    { id: 'r16_8', roundName: 'שמינית גמר 8', seed1: 6, seed2: 11, team1: getSeed(6), team2: getSeed(11), score1: null, score2: null, winner: null, nextMatchId: 'qf_4', nextSlot: 2 }
                ],
                qf: [
                    { id: 'qf_1', roundName: 'רבע גמר 1', team1: null, team2: null, score1: null, score2: null, winner: null, nextMatchId: 'sf_1', nextSlot: 1 },
                    { id: 'qf_2', roundName: 'רבע גמר 2', team1: null, team2: null, score1: null, score2: null, winner: null, nextMatchId: 'sf_1', nextSlot: 2 },
                    { id: 'qf_3', roundName: 'רבע גמר 3', team1: null, team2: null, score1: null, score2: null, winner: null, nextMatchId: 'sf_2', nextSlot: 1 },
                    { id: 'qf_4', roundName: 'רבע גמר 4', team1: null, team2: null, score1: null, score2: null, winner: null, nextMatchId: 'sf_2', nextSlot: 2 }
                ],
                sf: [
                    { id: 'sf_1', roundName: 'חצי גמר 1', team1: null, team2: null, score1: null, score2: null, winner: null, nextMatchId: 'final', nextSlot: 1 },
                    { id: 'sf_2', roundName: 'חצי גמר 2', team1: null, team2: null, score1: null, score2: null, winner: null, nextMatchId: 'final', nextSlot: 2 }
                ],
                final: {
                    id: 'final', roundName: '🏆 משחק הגמר',
                    team1: null, team2: null,
                    score1: null, score2: null, winner: null
                }
            };
        }

        // ברירת מחדל: 8 קבוצות
        return {
            qf: [
                {
                    id: 'qf_1', roundName: 'רבע גמר 1 (1v8)',
                    seed1: 1, seed2: 8,
                    team1: getSeed(1), team2: getSeed(8),
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_1', nextSlot: 1
                },
                {
                    id: 'qf_2', roundName: 'רבע גמר 2 (4v5)',
                    seed1: 4, seed2: 5,
                    team1: getSeed(4), team2: getSeed(5),
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_1', nextSlot: 2
                },
                {
                    id: 'qf_3', roundName: 'רבע גמר 3 (3v6)',
                    seed1: 3, seed2: 6,
                    team1: getSeed(3), team2: getSeed(6),
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_2', nextSlot: 1
                },
                {
                    id: 'qf_4', roundName: 'רבע גמר 4 (2v7)',
                    seed1: 2, seed2: 7,
                    team1: getSeed(2), team2: getSeed(7),
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_2', nextSlot: 2
                }
            ],
            sf: [
                {
                    id: 'sf_1', roundName: 'חצי גמר 1',
                    team1: null, team2: null,
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'final', nextSlot: 1
                },
                {
                    id: 'sf_2', roundName: 'חצי גמר 2',
                    team1: null, team2: null,
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'final', nextSlot: 2
                }
            ],
            final: {
                id: 'final', roundName: '🏆 משחק הגמר',
                team1: null, team2: null,
                score1: null, score2: null, winner: null
            }
        };
    }

    createEmptyPlayoffMatches(playoffSize) {
        return this.buildInitialKnockoutBracket([], playoffSize);
    }

    cleanTournamentName(name) {
        if (!name) return '';
        return name
            .replace(/\s*\(ארכיון\)/g, '')
            .replace(/\s*\(סגור\)/g, '')
            .replace(/\s*\(פעיל\)/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    sanitizeTournamentNames() {
        if (!Array.isArray(this.tournaments)) return;
        let changed = false;
        this.tournaments.forEach(t => {
            if (t.name && (t.name.includes('(ארכיון) (ארכיון)') || t.name.includes('(ארכיון)(ארכיון)') || t.name.includes('(ארכיון)  (ארכיון)'))) {
                t.name = t.name.replace(/(\s*\(ארכיון\))+/g, '').trim();
                changed = true;
                if (this.db) {
                    this.db.collection('tournaments').doc(t.id).update({ name: t.name }).catch(() => {});
                }
            }
        });
        if (changed) {
            this.saveTournamentsListLocally();
            this.populateTournamentSelectors();
        }
    }

    archiveCurrentTournament() {
        this.toggleCloseActiveTournament();
    }

    toggleCloseActiveTournament() {
        this.toggleCloseTournament(this.activeTournamentId);
    }

    async toggleCloseTournament(tourneyId) {
        if (this.currentRole !== 'owner' && this.currentRole !== 'admin') {
            this.showAlert("רק מנהל (Admin) או Owner רשאים לסגור או לפתוח טורניר!", "error");
            return;
        }

        const t = this.tournaments.find(tourney => tourney.id === tourneyId);
        if (!t) return;

        // ניקוי סיומות כפולות משם הטורניר
        const baseName = this.cleanTournamentName(t.name);

        if (t.isArchived) {
            // פתיחת טורניר מחדש
            t.isArchived = false;
            t.name = baseName;
            this.showAlert(`הטורניר "${t.name}" נפתח מחדש והוגדר כפעיל.`, "success");
        } else {
            // סגירת טורניר
            t.isArchived = true;
            t.name = baseName;
            this.showAlert(`הטורניר "${t.name}" נסגר בהצלחה והועבר לארכיון.`, "warning");
        }

        this.saveTournamentsListLocally();

        if (this.db) {
            try {
                await this.db.collection('tournaments').doc(t.id).set(t);
                console.log(`[Firestore] Tournament ${t.id} archive status updated: ${t.isArchived}`);
            } catch (err) {
                console.warn("[Firestore] Failed to update tournament archive status in cloud:", err);
            }
        }

        if (t.id === this.activeTournamentId) {
            this.loadTournamentData(t.id);
        }
        this.populateTournamentSelectors();
        this.renderOwnerTournamentsList();
        this.updateCloseButtonUI();
        this.updateArchiveBannerUI();
        this.switchRole(this.currentRole);
    }

    updateCloseButtonUI() {
        const curr = this.tournaments.find(t => t.id === this.activeTournamentId);
        const isClosed = curr ? curr.isArchived : false;

        const ownerBtn = document.getElementById('ownerCloseTourneyBtn');
        if (ownerBtn) {
            ownerBtn.innerHTML = isClosed ? '🔓 פתח טורניר נוכחי מחדש' : '🔒 סגור טורניר נוכחי';
            ownerBtn.className = isClosed ? 'btn-success' : 'btn-secondary';
        }

        const setupBtn = document.getElementById('setupCloseTournamentBtn');
        if (setupBtn) {
            setupBtn.innerHTML = isClosed ? '🔓 פתח טורניר מחדש' : '🔒 סגור טורניר';
            setupBtn.className = isClosed ? 'btn-success btn-sm admin-editable' : 'btn-secondary btn-sm admin-editable';
        }

        this.updateArchiveBannerUI();
    }

    viewTournamentFromList(tourneyId) {
        if (!tourneyId) return;
        const tourney = this.tournaments.find(t => t.id === tourneyId);
        if (!tourney) return;

        // טעינת הטורניר הנבחר
        if (tourneyId !== this.activeTournamentId) {
            this.switchTournament(tourneyId, false);
        }

        // מעבר מיידי לטאב התואם למבנה הטורניר (בתים או פלייאוף)
        const targetTab = (tourney.format === 'knockout_only') ? 'playoffs' : 'group-stage';
        this.switchTab(targetTab);
        this.showAlert(`עברת לצפייה ב-${tourney.name}.`, "success");
    }

    deleteActiveTournament() {
        if (!this.activeTournamentId) {
            this.showAlert("לא נבחר טורניר פעיל למחיקה.", "warning");
            return;
        }
        this.deleteTournament(this.activeTournamentId);
    }

    async deleteTournament(tourneyId) {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק מנהל העל (Owner) רשאי למחוק טורניר!", "error");
            return;
        }

        const tourney = this.tournaments.find(t => t.id === tourneyId);
        if (!tourney) {
            this.showAlert("הטורניר לא נמצא.", "error");
            return;
        }

        const deletedName = tourney.name;
        const wasActive = (this.activeTournamentId === tourneyId);

        if (this.tournaments.length <= 1) {
            if (!confirm(`הטורניר "${deletedName}" הוא הטורניר היחיד במערכת. מחיקתו תאפס את הנתונים ותקים טורניר ברירת מחדל חדש ונקי. האם להמשיך?`)) {
                return;
            }

            // מחיקה מ-Firestore
            if (this.db) {
                try {
                    await this.db.collection('tournaments').doc(tourneyId).delete();
                } catch (err) {
                    console.error("[Firestore] Error deleting tournament from Firestore:", err);
                }
            }

            const newTourneyId = `tourney_${Date.now()}`;
            const numGroups = 3;
            const teamsPerGroup = 5;
            const playoffSize = 8;
            const teams = [...this.defaultTeams];
            const groupLetters = ['A', 'B', 'C'];
            const groups = {};
            const standings = {};
            for (let g = 0; g < numGroups; g++) {
                const grpKey = `Group ${groupLetters[g]}`;
                const grpTeams = [];
                for (let t = 0; t < teamsPerGroup; t++) {
                    const idx = g * teamsPerGroup + t;
                    grpTeams.push({ index: idx, name: teams[idx], group: grpKey });
                }
                groups[grpKey] = grpTeams;
                standings[grpKey] = grpTeams.map(item => ({
                    teamIndex: item.index,
                    teamName: teams[item.index],
                    group: grpKey,
                    played: 0, wins: 0, draws: 0, losses: 0,
                    pointsFor: 0, pointsAgainst: 0, pointDiff: 0,
                    pts: 0, groupRank: 0
                }));
            }
            const matches = this.generateDynamicRoundRobin(groups, teams, teamsPerGroup);
            const playoffMatches = this.createEmptyPlayoffMatches(playoffSize);
            const freshTourney = {
                id: newTourneyId,
                name: 'טורניר חדש',
                format: 'groups_and_playoff',
                numGroups,
                teamsPerGroup,
                playoffSize,
                pointsPerWin: 3,
                pointsPerDraw: 1,
                createdAt: new Date().toLocaleDateString('he-IL'),
                isArchived: false,
                teams,
                groups,
                matches,
                standings,
                playoffSeeds: [],
                playoffMatches
            };

            this.tournaments = [freshTourney];
            this.saveTournamentsList();
            this.activeTournamentId = newTourneyId;
            this.loadTournamentData(newTourneyId);
            this.populateTournamentSelectors();
            this.renderOwnerTournamentsList();
            this.updateCloseButtonUI();
            this.showAlert(`הטורניר "${deletedName}" נמחק. נוצר טורניר חדש ונקי.`, "success");
            return;
        }

        if (!confirm(`האם אתה בטוח שברצונך למחוק לצמיתות את הטורניר "${tourney.name}"? פעולה זו תמחק את כל המשחקים והנתונים של הטורניר ממסד הנתונים ולא ניתן לשחזרה.`)) {
            return;
        }

        // הסרה מקומית
        this.tournaments = this.tournaments.filter(t => t.id !== tourneyId);
        this.saveTournamentsListLocally();

        // מחיקה מ-Firestore
        if (this.db) {
            try {
                await this.db.collection('tournaments').doc(tourneyId).delete();
                console.log(`[Firestore] Tournament ${tourneyId} deleted from Firestore.`);
            } catch (err) {
                console.error("[Firestore] Error deleting tournament from Firestore:", err);
                this.showAlert("שגיאה במחיקת הטורניר ממסד הנתונים: " + err.message, "error");
            }
        }

        // אם הטורניר שנמחק היה הפעיל, מעבר לטורניר הבא
        if (wasActive) {
            const nextTourney = this.tournaments[0];
            this.activeTournamentId = nextTourney.id;
            this.loadTournamentData(nextTourney.id);
        }

        this.populateTournamentSelectors();
        this.renderOwnerTournamentsList();
        this.updateCloseButtonUI();
        this.showAlert(`הטורניר "${deletedName}" נמחק בהצלחה לצמיתות.`, "warning");
    }

    renderOwnerTournamentsList() {
        const container = document.getElementById('ownerTournamentsList');
        if (!container) return;

        this.sanitizeTournamentNames();

        container.innerHTML = `
            <table class="admins-table">
                <thead>
                    <tr>
                        <th>שם הטורניר</th>
                        <th>מבנה</th>
                        <th>סטטוס</th>
                        <th>תאריך פתיחה</th>
                        <th style="width: 260px; text-align: center;">פעולות</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.tournaments.map(t => {
                        const fmtBadge = (t.format === 'knockout_only') 
                            ? `<span style="background:#fee2e2; color:#991b1b; padding:2px 6px; border-radius:8px; font-size:0.78rem; font-weight:700;">⚔️ נוקאאוט</span>`
                            : (t.format === 'groups_only')
                            ? `<span style="background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:8px; font-size:0.78rem; font-weight:700;">⚽ בתים בלבד</span>`
                            : `<span style="background:#dbeafe; color:#1e40af; padding:2px 6px; border-radius:8px; font-size:0.78rem; font-weight:700;">⚽ בתים + פלייאוף</span>`;

                        const statusBadge = t.isArchived
                            ? `<span style="background:#fef3c7; color:#92400e; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:700;">🔒 סגור (ארכיון)</span>`
                            : `<span style="background:#dcfce7; color:#15803d; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:700;">⚡ פעיל</span>`;

                        const isCurrentlyActive = (t.id === this.activeTournamentId);

                        const deleteBtnHtml = (this.currentRole === 'owner') ? `
                            <button type="button" class="btn-delete-admin btn-sm" onclick="app.deleteTournament('${t.id}')" title="מחק טורניר לצמיתות (Owner בלבד)" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; padding:4px 8px; font-size:0.8rem; border-radius:6px; cursor:pointer;">
                                🗑️ מחק
                            </button>
                        ` : '';

                        return `
                            <tr style="${isCurrentlyActive ? 'background:#f0fdf4;' : ''}">
                                <td style="font-weight:700;">${t.name}</td>
                                <td>${fmtBadge}</td>
                                <td>${statusBadge}</td>
                                <td style="color:#6b5b45; font-size:0.85rem;">${t.createdAt || '-'}</td>
                                <td style="text-align:center;">
                                    <div style="display:flex; gap:6px; justify-content:center; align-items:center; flex-wrap:wrap;">
                                        <button type="button" class="btn-secondary btn-sm" onclick="app.viewTournamentFromList('${t.id}')" title="מעבר לצפייה בטורניר ובמשחקים">
                                            ${isCurrentlyActive ? '👁️ צפה (פעיל)' : '👁️ צפה בטורניר'}
                                        </button>
                                        <button type="button" class="btn-edit-user btn-sm" onclick="app.openEditTournamentModal('${t.id}')" title="${t.isArchived ? 'לא ניתן לערוך טורניר סגור' : 'עריכת מבנה טורניר'}" ${t.isArchived ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''}>
                                            ⚙️ ערוך
                                        </button>
                                        <button type="button" class="btn-sm btn-secondary" onclick="app.toggleCloseTournament('${t.id}')" title="${t.isArchived ? 'פתח טורניר מחדש' : 'סגור טורניר והעבר לארכיון'}">
                                            ${t.isArchived ? '🔓 פתח' : '🔒 סגור'}
                                        </button>
                                        ${deleteBtnHtml}
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
    }

    /* ========================================================
       התראות, ניווט בטאבים והזנת שמות קבוצות דינמיות
       ======================================================== */

    showAlert(message, type = 'error') {
        const toast = document.getElementById('tournament-alert');
        if (!toast) return;

        let icon = '⚠️';
        if (type === 'success') icon = '✅';
        if (type === 'warning') icon = '📢';

        toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
        toast.className = `tournament-alert alert-${type}`;

        if (this.alertTimeout) clearTimeout(this.alertTimeout);
        this.alertTimeout = setTimeout(() => {
            toast.className = 'tournament-alert hidden';
        }, 4500);
    }

    switchTab(tabId) {
        this.openPlayoffMatchId = null;
        try { sessionStorage.setItem('tournament_active_tab', tabId); } catch (e) {}
        document.querySelectorAll('.tab-section').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

        const targetSection = document.getElementById(`tab-${tabId}`);
        if (targetSection) targetSection.classList.remove('hidden');

        const targetBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => 
            btn.getAttribute('onclick')?.includes(`'${tabId}'`)
        );
        if (targetBtn) targetBtn.classList.add('active');

        if (tabId === 'users') {
            this.renderUsersManagement();
            this.renderOwnerTournamentsList();
        }
    }

    renderTeamInputs() {
        const container = document.getElementById('teams-input-container');
        const titleEl = document.getElementById('setup-header-title');
        const subEl = document.getElementById('setup-header-subtitle');
        const genBtn = document.getElementById('btn-generate-groups');
        if (!container) return;

        const isClosed = this.isCurrentTournamentClosed();
        const isReadOnly = (this.currentRole === 'viewer') || isClosed;

        container.innerHTML = '';

        if (this.format === 'knockout_only') {
            if (titleEl) titleEl.textContent = `הזנת קבוצות הטורניר (${this.teams.length} קבוצות - נוקאאוט בלבד)`;
            if (subEl) subEl.textContent = isClosed 
                ? `🔒 הטורניר סגור ונעול לעריכה (מצב קריאה בלבד). לפתיחתו יש ללחוץ על 'פתח טורניר מחדש'.`
                : `מיועד ל-Admin/Owner בלבד. הזן את שמות ${this.teams.length} הקבוצות המשתתפות ישירות בעץ הפלייאוף:`;
            if (genBtn) genBtn.textContent = `🔄 סנכרן שמות קבוצות לעץ הפלייאוף`;

            this.teams.forEach((teamName, index) => {
                const div = document.createElement('div');
                div.className = 'team-input-group';
                div.innerHTML = `
                    <label class="team-label-rtl">
                        <span class="team-num-prefix">${index + 1}</span>
                        <span>קבוצה מדורגת #${index + 1}</span>
                    </label>
                    <input type="text" value="${teamName}" data-index="${index}" 
                           ${isReadOnly ? 'disabled' : ''}
                           onchange="app.updateTeamName(${index}, this.value)"
                           placeholder="הזן שם קבוצה">
                `;
                container.appendChild(div);
            });
        } else {
            const numGroups = this.numGroups || (this.groups ? Object.keys(this.groups).length : 3);
            const teamsPerGroup = this.teamsPerGroup || 5;
            const groupHebrew = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'"];

            if (titleEl) titleEl.textContent = `הזנת קבוצות הטורניר (${this.teams.length} קבוצות ב-${numGroups} בתים)`;
            if (subEl) subEl.textContent = isClosed
                ? `🔒 הטורניר סגור ונעול לעריכה (מצב קריאה בלבד). לפתיחתו יש ללחוץ על 'פתח טורניר מחדש'.`
                : `מיועד ל-Admin/Owner בלבד. הזן או עדכן שמות ל-${this.teams.length} הקבוצות (מחולקות ל-${numGroups} בתים של ${teamsPerGroup} קבוצות):`;
            if (genBtn) genBtn.textContent = `⚡ ייצר לוח משחקים לשלב הבתים (${this.matches.length || (numGroups * (teamsPerGroup * (teamsPerGroup - 1)) / 2)} משחקים)`;

            this.teams.forEach((teamName, index) => {
                const groupIdx = Math.floor(index / teamsPerGroup);
                const posInGroup = (index % teamsPerGroup) + 1;
                const groupHe = groupHebrew[groupIdx] || (groupIdx + 1);

                const div = document.createElement('div');
                div.className = 'team-input-group';
                div.innerHTML = `
                    <label class="team-label-rtl">
                        <span class="team-num-prefix">${index + 1}</span>
                        <span>בית ${groupHe} - קבוצה ${posInGroup}</span>
                    </label>
                    <input type="text" value="${teamName}" data-index="${index}" 
                           ${isReadOnly ? 'disabled' : ''}
                           onchange="app.updateTeamName(${index}, this.value)"
                           placeholder="הזן שם קבוצה">
                `;
                container.appendChild(div);
            });
        }
    }

    updateTeamName(index, newName) {
        if (this.isCurrentTournamentClosed()) return;
        const trimmed = newName.trim();
        this.teams[index] = trimmed || `קבוצה ${index + 1}`;

        if (this.format === 'knockout_only') {
            if (this.playoffSeeds && this.playoffSeeds[index]) {
                this.playoffSeeds[index].teamName = this.teams[index];
            }
            this.syncTeamNamesToKnockoutBracket();
            this.renderPlayoffBracket();
        } else {
            this.syncTeamNamesToMatches();
        }
        this.saveActiveTournamentData();
    }

    fillDefaultTeamNames() {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        this.teams = this.teams.map((_, i) => this.defaultTeams[i] || `קבוצה ${i + 1}`);
        this.renderTeamInputs();
        if (this.format === 'knockout_only') {
            if (this.playoffSeeds) {
                this.playoffSeeds.forEach((s, i) => { s.teamName = this.teams[i]; });
            }
            this.syncTeamNamesToKnockoutBracket();
            this.renderPlayoffBracket();
        } else {
            this.syncTeamNamesToMatches();
        }
        this.saveActiveTournamentData();
        this.showAlert("שמות הקבוצות שוחזרו בהצלחה.", "success");
    }

    syncTeamNamesToKnockoutBracket() {
        if (!this.playoffMatches) return;
        ['r16', 'qf', 'sf'].forEach(roundKey => {
            const matches = this.playoffMatches[roundKey];
            if (Array.isArray(matches)) {
                matches.forEach(m => {
                    if (m.team1 && m.team1.teamIndex !== undefined) {
                        m.team1.teamName = this.teams[m.team1.teamIndex];
                    }
                    if (m.team2 && m.team2.teamIndex !== undefined) {
                        m.team2.teamName = this.teams[m.team2.teamIndex];
                    }
                });
            }
        });
        if (this.playoffMatches.final) {
            const m = this.playoffMatches.final;
            if (m.team1 && m.team1.teamIndex !== undefined) m.team1.teamName = this.teams[m.team1.teamIndex];
            if (m.team2 && m.team2.teamIndex !== undefined) m.team2.teamName = this.teams[m.team2.teamIndex];
        }
    }

    syncTeamNamesToMatches() {
        if (!this.matches || this.matches.length === 0) return;
        this.matches.forEach(m => {
            m.team1Name = this.teams[m.team1Index];
            m.team2Name = this.teams[m.team2Index];
        });
        this.renderMatches();
        this.calculateStandings();
    }

    /* ========================================================
       אלגוריתם 1: Round-Robin דינמי לכל כמות בתים וקבוצות
       ======================================================== */

    generateTournamentGroups(shouldSwitchTab = true) {
        if (shouldSwitchTab && this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה. לפתיחתו יש ללחוץ על 'פתח טורניר מחדש'.", "warning");
            return;
        }

        if (shouldSwitchTab && this.isGroupStageLocked()) {
            this.showAlert("שלב הבתים כבר ננעל ושובץ לפלייאוף. לא ניתן לייצר מחדש את לוח המשחקים.", "warning");
            return;
        }

        if (this.format === 'knockout_only') {
            this.syncTeamNamesToKnockoutBracket();
            this.renderPlayoffBracket();
            if (shouldSwitchTab) {
                this.switchTab('playoffs');
                this.showAlert("שמות הקבוצות סונכרנו לעץ הפלייאוף!", "success");
            }
            return;
        }

        const numGroups = this.numGroups || 2;
        const teamsPerGroup = this.teamsPerGroup || 4;
        const totalTeams = numGroups * teamsPerGroup;
        const groupLetters = ['A', 'B', 'C', 'D', 'E', 'F'];
        const groups = {};

        // וידוא מערך הקבוצות באורך המדויק למבנה
        if (!this.teams || this.teams.length !== totalTeams) {
            const currentTeams = this.teams || [];
            const newTeams = [];
            for (let i = 0; i < totalTeams; i++) {
                if (i < currentTeams.length && currentTeams[i]) {
                    newTeams.push(currentTeams[i]);
                } else if (i < this.defaultTeams.length) {
                    newTeams.push(this.defaultTeams[i]);
                } else {
                    newTeams.push(`קבוצה ${i + 1}`);
                }
            }
            this.teams = newTeams;
        }

        for (let g = 0; g < numGroups; g++) {
            const grpKey = `Group ${groupLetters[g]}`;
            const startIndex = g * teamsPerGroup;
            const grpTeams = [];
            for (let t = 0; t < teamsPerGroup; t++) {
                const idx = startIndex + t;
                grpTeams.push({ index: idx, name: this.teams[idx] || `קבוצה ${idx + 1}`, group: grpKey });
            }
            groups[grpKey] = grpTeams;
        }
        this.groups = groups;

        // איפוס סינון בתים כדי שלא יישאר מסונן על בית ישן שנמחק (כמו בית ג')
        this.currentFilter = 'all';
        this.currentTeamFilter = 'all';

        this.matches = this.generateDynamicRoundRobin(groups, this.teams, teamsPerGroup);
        this.renderTeamInputs();
        this.renderMatches();
        this.calculateStandings();
        this.saveActiveTournamentData();

        const seedBtns = document.querySelectorAll('.btn-seed-playoffs-action');
        if (this.format === 'groups_and_playoff') {
            seedBtns.forEach(btn => btn.classList.remove('hidden'));
        } else {
            seedBtns.forEach(btn => btn.classList.add('hidden'));
        }

        if (shouldSwitchTab) {
            this.switchTab('group-stage');
            this.showAlert(`לוח המשחקים נוצר בהצלחה! ${this.matches.length} משחקים חולקו ל-${numGroups} בתים.`, "success");
        }
    }

    renderMatchCardHtml(m, isViewer) {
        const isReadOnlyStage = isViewer || this.isGroupStageLocked();
        const row1WinnerClass = m.winner === 'team1' ? 'winner' : (m.winner === 'draw' ? 'draw-match' : '');
        const row2WinnerClass = m.winner === 'team2' ? 'winner' : (m.winner === 'draw' ? 'draw-match' : '');
        const score1Val = m.score1 !== null ? m.score1 : '';
        const score2Val = m.score2 !== null ? m.score2 : '';

        const score1Field = isReadOnlyStage
            ? `<span class="score-display-viewer">${score1Val !== '' ? score1Val : '-'}</span>`
            : `<input type="number" min="0" step="1" 
                      class="score-input" 
                      value="${score1Val}" 
                      placeholder="-" 
                      oninput="app.handleScoreChange('${m.id}', 1, this.value, this)">`;

        const score2Field = isReadOnlyStage
            ? `<span class="score-display-viewer">${score2Val !== '' ? score2Val : '-'}</span>`
            : `<input type="number" min="0" step="1" 
                      class="score-input" 
                      value="${score2Val}" 
                      placeholder="-" 
                      oninput="app.handleScoreChange('${m.id}', 2, this.value, this)">`;

        return `
            <div class="match-card" id="card-${m.id}" data-match-id="${m.id}">
                <div class="match-header">
                    <span>${m.groupNameHe} • מחזור ${m.round}</span>
                    <span class="match-badge">משחק #${m.matchNumber}</span>
                </div>
                
                <div class="match-team-row ${row1WinnerClass}" id="row-${m.id}-1">
                    <span class="team-name" title="${m.team1Name}">${m.team1Name}</span>
                    ${score1Field}
                </div>

                <div class="match-team-row ${row2WinnerClass}" id="row-${m.id}-2">
                    <span class="team-name" title="${m.team2Name}">${m.team2Name}</span>
                    ${score2Field}
                </div>
            </div>
        `;
    }

    renderMatches() {
        const container = document.getElementById('group-matches-container');
        const filterContainer = document.getElementById('group-filter-container');
        if (!container) return;

        const groupMatches = this.currentFilter === 'all'
            ? this.matches
            : this.matches.filter(m => m.groupId === this.currentFilter);

        // רשימת הקבוצות לסינון - רק קבוצות מהבית שנבחר
        const teamNames = [...new Set(groupMatches.flatMap(m => [m.team1Name, m.team2Name]))]
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'he'));
        if (this.currentTeamFilter !== 'all' && !teamNames.includes(this.currentTeamFilter)) {
            this.currentTeamFilter = 'all';
        }

        // רינדור רשימות סינון נפתחות (בית + קבוצה) לפי נתוני הטורניר
        if (filterContainer && this.groups && Object.keys(this.groups).length > 0) {
            const groupHebrew = {
                'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
                'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
            };
            const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
            const grpKeys = Object.keys(this.groups);
            const filtersHtml = `
                <label class="filter-select-wrap">
                    <span>🏠 בית</span>
                    <select id="matchGroupFilter" class="filter-select" onchange="app.filterMatches(this.value)">
                        <option value="all" ${this.currentFilter === 'all' ? 'selected' : ''}>כל הבתים (${this.matches.length})</option>
                        ${grpKeys.map(k => {
                            const count = this.matches.filter(m => m.groupId === k).length;
                            return `<option value="${k}" ${this.currentFilter === k ? 'selected' : ''}>${groupHebrew[k] || k} (${count})</option>`;
                        }).join('')}
                    </select>
                </label>
                <label class="filter-select-wrap">
                    <span>👥 קבוצה</span>
                    <select id="matchTeamFilter" class="filter-select" onchange="app.filterMatchesByTeam(this.value)">
                        <option value="all" ${this.currentTeamFilter === 'all' ? 'selected' : ''}>כל הקבוצות</option>
                        ${teamNames.map(name => `<option value="${escAttr(name)}" ${this.currentTeamFilter === name ? 'selected' : ''}>${escAttr(name)}</option>`).join('')}
                    </select>
                </label>
            `;
            // עדכון רק כשיש שינוי, כדי לא לסגור רשימה פתוחה בזמן סנכרון נתונים
            if (filterContainer.dataset.rendered !== filtersHtml) {
                filterContainer.innerHTML = filtersHtml;
                filterContainer.dataset.rendered = filtersHtml;
            }
        }

        const filteredMatches = this.currentTeamFilter === 'all'
            ? groupMatches
            : groupMatches.filter(m => m.team1Name === this.currentTeamFilter || m.team2Name === this.currentTeamFilter);

        if (filteredMatches.length === 0) {
            container.innerHTML = '<p class="placeholder-text">אין משחקים להצגה.</p>';
            return;
        }

        const isViewer = (this.currentRole === 'viewer') || this.isCurrentTournamentClosed();

        const followedTeam = this.guestPreferences?.teamName;
        let contentHtml = '';

        if (followedTeam) {
            const followedMatches = filteredMatches.filter(m => m.team1Name === followedTeam || m.team2Name === followedTeam);
            const otherMatches = filteredMatches.filter(m => m.team1Name !== followedTeam && m.team2Name !== followedTeam);

            if (followedMatches.length > 0) {
                contentHtml += `
                    <div class="followed-matches-container">
                        <div class="followed-matches-title">
                            ⭐ משחקי הקבוצה במעקב: <strong>${followedTeam}</strong> (${followedMatches.length} משחקים)
                        </div>
                        <div class="matches-grid">
                            ${followedMatches.map(m => this.renderMatchCardHtml(m, isViewer)).join('')}
                        </div>
                    </div>
                `;
            }

            if (otherMatches.length > 0) {
                contentHtml += `
                    <div class="all-matches-divider">
                        <span>📅 כל שאר משחקי הטורניר (${otherMatches.length})</span>
                    </div>
                    <div class="matches-grid">
                        ${otherMatches.map(m => this.renderMatchCardHtml(m, isViewer)).join('')}
                    </div>
                `;
            }
        } else {
            contentHtml = `
                <div class="matches-grid">
                    ${filteredMatches.map(m => this.renderMatchCardHtml(m, isViewer)).join('')}
                </div>
            `;
        }

        container.innerHTML = contentHtml;
    }

    filterMatches(groupKey) {
        this.currentFilter = groupKey;
        this.renderMatches();
        document.getElementById('matchGroupFilter')?.focus();
    }

    filterMatchesByTeam(teamName) {
        this.currentTeamFilter = teamName;
        this.renderMatches();
        document.getElementById('matchTeamFilter')?.focus();
    }

    /* ========================================================
       אלגוריתם 2: אימות תוצאות ואיסור תיקו מוחלט (No-Ties Rule)
       ======================================================== */

    handleScoreChange(matchId, teamNum, rawValue, inputElement) {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול. לא ניתן לשנות תוצאות.", "warning");
            return;
        }

        if (this.isGroupStageLocked()) {
            this.showAlert("שלב הבתים ננעל ושובץ לפלייאוף. כדי לערוך תוצאות בשלב הבתים, יש לאפס את שיבוץ הפלייאוף תחילה.", "warning");
            return;
        }

        const match = this.matches.find(m => m.id === matchId);
        if (!match) return;

        if (rawValue === '' || rawValue === null || rawValue === undefined) {
            if (teamNum === 1) match.score1 = null;
            if (teamNum === 2) match.score2 = null;
            match.winner = null;
            this.updateMatchRowWinners(match);
            this.calculateStandings();
            this.saveActiveTournamentData();
            return;
        }

        const parsed = Number(rawValue);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
            this.showAlert("שגיאת תוצאה: יש להזין מספר שלם וחיובי (0 ומעלה) בלבד.", "error");
            inputElement.value = '';
            if (teamNum === 1) match.score1 = null;
            if (teamNum === 2) match.score2 = null;
            match.winner = null;
            this.updateMatchRowWinners(match);
            this.calculateStandings();
            return;
        }

        if (teamNum === 1) match.score1 = parsed;
        else match.score2 = parsed;

        if (match.score1 !== null && match.score2 !== null) {
            if (match.score1 === match.score2) {
                match.winner = 'draw';
            } else {
                match.winner = (match.score1 > match.score2) ? 'team1' : 'team2';
            }
        } else {
            match.winner = null;
        }

        this.updateMatchRowWinners(match);
        this.calculateStandings();
        this.saveActiveTournamentData();
    }

    updateMatchRowWinners(match) {
        const row1 = document.getElementById(`row-${match.id}-1`);
        const row2 = document.getElementById(`row-${match.id}-2`);
        if (row1 && row2) {
            row1.classList.remove('winner', 'draw-match');
            row2.classList.remove('winner', 'draw-match');
            if (match.winner === 'team1') {
                row1.classList.add('winner');
            } else if (match.winner === 'team2') {
                row2.classList.add('winner');
            } else if (match.winner === 'draw') {
                row1.classList.add('draw-match');
                row2.classList.add('draw-match');
            }
        }
    }

    /* ========================================================
       אלגוריתם 3: טבלאות דירוג דינמיות
       ======================================================== */

    calculateStandings() {
        if (!this.groups || Object.keys(this.groups).length === 0) return;

        const groupHeaders = {
            'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
            'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
        };

        const calculatedStandings = {};
        const ptsWin = (this.pointsPerWin !== undefined) ? this.pointsPerWin : 3;
        const ptsDraw = (this.pointsPerDraw !== undefined) ? this.pointsPerDraw : 1;

        Object.keys(this.groups).forEach(grpKey => {
            const teamsInGroup = this.groups[grpKey] || [];
            const stats = teamsInGroup.map(t => ({
                teamIndex: t.index,
                teamName: (this.teams && this.teams[t.index]) ? this.teams[t.index] : (t.name || `קבוצה ${t.index + 1}`),
                group: grpKey,
                played: 0,
                wins: 0,
                draws: 0,
                losses: 0,
                pointsFor: 0,
                pointsAgainst: 0,
                pointDiff: 0,
                pts: 0
            }));

            const groupMatches = this.matches.filter(m => m.groupId === grpKey);
            groupMatches.forEach(m => {
                if (m.score1 !== null && m.score2 !== null && m.winner !== null) {
                    const t1 = stats.find(s => s.teamIndex === m.team1Index);
                    const t2 = stats.find(s => s.teamIndex === m.team2Index);
                    if (t1 && t2) {
                        t1.played++; t2.played++;
                        t1.pointsFor += m.score1; t1.pointsAgainst += m.score2;
                        t2.pointsFor += m.score2; t2.pointsAgainst += m.score1;
                        if (m.winner === 'team1') {
                            t1.wins++;
                            t1.pts += ptsWin;
                            t2.losses++;
                        } else if (m.winner === 'team2') {
                            t2.wins++;
                            t2.pts += ptsWin;
                            t1.losses++;
                        } else if (m.winner === 'draw') {
                            t1.draws++;
                            t2.draws++;
                            t1.pts += ptsDraw;
                            t2.pts += ptsDraw;
                        }
                    }
                }
            });

            stats.forEach(s => { s.pointDiff = s.pointsFor - s.pointsAgainst; });

            // שובר שוויון מדויק לפי דרישת המשתמש: נקודות -> הפרש שערים -> זכות -> ניצחונות
            stats.sort((a, b) => {
                if (b.pts !== a.pts) return b.pts - a.pts;
                if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
                if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
                if (b.wins !== a.wins) return b.wins - a.wins;
                return (a.teamName || '').localeCompare(b.teamName || '');
            });

            stats.forEach((s, idx) => { s.groupRank = idx + 1; });
            calculatedStandings[grpKey] = stats;
        });

        this.standings = calculatedStandings;
        this.renderStandings(groupHeaders);
    }

    renderStandings(groupHeaders) {
        const container = document.getElementById('group-standings-container');
        if (!container) return;

        // עדכון באנר מעקב אישי
        this.renderGuestFollowedBanner();

        // עדכון מקרא הטבלה בהתאם לסוג הטורניר
        const legendContainer = document.querySelector('.standings-legend');
        if (legendContainer) {
            if (this.format === 'groups_only') {
                legendContainer.innerHTML = `
                    <span class="legend-item"><span class="legend-color" style="background:#fefce8; border:1px solid #eab308;"></span> 🏆 מקום 1 (אלופת הבית המובילה בדירוג)</span>
                `;
            } else if (this.numGroups === 2) {
                legendContainer.innerHTML = `
                    <span class="legend-item"><span class="legend-color" style="background:#ecfdf5; border:1px solid #22c55e;"></span> עולה ישירה לפלייאוף (מקומות 1-2)</span>
                `;
            } else {
                legendContainer.innerHTML = `
                    <span class="legend-item"><span class="legend-color" style="background:#ecfdf5; border:1px solid #22c55e;"></span> עולה ישירה (מקומות 1-2)</span>
                    <span class="legend-item"><span class="legend-color" style="background:#fefce8; border:1px solid #f59e0b;"></span> מועמד (מקום 3 הטוב ביותר)</span>
                `;
            }
        }

        const headers = groupHeaders || {
            'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
            'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
        };

        let entries = Object.entries(this.standings);
        const followedTeam = this.guestPreferences?.teamName;
        const followedGroup = this.guestPreferences?.groupKey;

        // אם המשתמש בחר קבוצה או בית למעקב - מציגים את הבית שלו ראשון בראש העמוד
        if (followedTeam) {
            entries.sort(([keyA, teamsA], [keyB, teamsB]) => {
                const hasA = teamsA.some(t => t.teamName === followedTeam);
                const hasB = teamsB.some(t => t.teamName === followedTeam);
                if (hasA && !hasB) return -1;
                if (!hasA && hasB) return 1;
                return 0;
            });
        } else if (followedGroup && followedGroup !== 'all') {
            entries.sort(([keyA], [keyB]) => {
                if (keyA === followedGroup && keyB !== followedGroup) return -1;
                if (keyA !== followedGroup && keyB === followedGroup) return 1;
                return 0;
            });
        }

        let html = '';

        for (const [grpKey, teams] of entries) {
            const grpMatches = this.matches.filter(m => m.groupId === grpKey);
            const grpPlayed = grpMatches.filter(m => m.score1 !== null && m.score2 !== null).length;
            const totalMatchesInGroup = grpMatches.length;
            const isExpanded = !!(this.expandedStandingsGroups && this.expandedStandingsGroups[grpKey]);

            html += `
                <div class="standings-group-card">
                    <div class="standings-group-header">
                        <div class="standings-header-title-box">
                            <span>${headers[grpKey] || grpKey}</span>
                            <span class="group-progress-text">שוחקו: ${grpPlayed}/${totalMatchesInGroup} משחקים</span>
                        </div>
                        <button type="button" class="btn-toggle-stats-detail" onclick="app.toggleStandingsDetails('${grpKey}')" title="הצג/הסתר פירוט עמודות מלא">
                            ${isExpanded ? '⚡ תצוגה מקוצרת' : '📊 פירוט מלא'}
                        </button>
                    </div>
                    <div class="standings-table-wrap ${isExpanded ? 'show-all-stats' : ''}">
                        <table class="standings-table">
                            <thead>
                                <tr>
                                    <th style="width: 38px;">מיקום</th>
                                    <th style="text-align: right; padding-right: 10px;">קבוצה</th>
                                    <th style="width: 34px;">מש'</th>
                                    <th style="width: 34px;">ניצ'</th>
                                    <th class="col-stat-detail" style="width: 34px;">תיקו</th>
                                    <th class="col-stat-detail" style="width: 34px;">הפ'</th>
                                    <th class="col-stat-detail" style="width: 36px;">זכות</th>
                                    <th class="col-stat-detail" style="width: 36px;">חובה</th>
                                    <th style="width: 44px;">הפרש</th>
                                    <th class="pts-th" style="width: 46px;">נק'</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${teams.map(t => {
                                    let rowClass = '';
                                    let rankClass = 'rank-out';
                                    let rankDisplay = `${t.groupRank}`;

                                    if (this.format === 'groups_only') {
                                        if (t.groupRank === 1) {
                                            rowClass = 'row-champion';
                                            rankClass = 'rank-champion';
                                            rankDisplay = `🏆 1`;
                                        }
                                    } else if (this.numGroups === 2) {
                                        if (t.groupRank <= 2) {
                                            rowClass = 'row-direct-qualify';
                                            rankClass = 'rank-top';
                                        }
                                    } else {
                                        if (t.groupRank <= 2) {
                                            rowClass = 'row-direct-qualify';
                                            rankClass = 'rank-top';
                                        } else if (t.groupRank === 3) {
                                            rowClass = 'row-candidate-qualify';
                                            rankClass = 'rank-third';
                                        }
                                    }

                                    const isFollowed = (followedTeam && t.teamName === followedTeam);
                                    if (isFollowed) {
                                        rowClass += ' row-followed-team';
                                    }

                                    let diffClass = 'diff-zero';
                                    let diffStr = `${t.pointDiff}`;
                                    if (t.pointDiff > 0) {
                                        diffClass = 'diff-positive';
                                        diffStr = `+${t.pointDiff}`;
                                    } else if (t.pointDiff < 0) {
                                        diffClass = 'diff-negative';
                                    }

                                    return `
                                        <tr class="${rowClass}">
                                            <td><span class="rank-indicator ${rankClass}">${rankDisplay}</span></td>
                                            <td class="team-cell" title="${t.teamName}">
                                                ${isFollowed ? '<span class="followed-team-star">⭐</span>' : ''}
                                                <span class="team-name-text">${t.teamName}</span>
                                            </td>
                                            <td>${t.played}</td>
                                            <td style="color:#16a34a; font-weight:800;">${t.wins}</td>
                                            <td style="color:#57493a; font-weight:700;">${t.draws || 0}</td>
                                            <td style="color:#dc2626;">${t.losses}</td>
                                            <td>${t.pointsFor}</td>
                                            <td>${t.pointsAgainst}</td>
                                            <td class="${diffClass}">${diffStr}</td>
                                            <td class="pts-td"><span class="pts-pill">${t.pts}</span></td>
                                        </tr>
                                    `;
                                }).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }

        container.innerHTML = html;
    }

    toggleStandingsDetails(grpKey) {
        if (!this.expandedStandingsGroups) this.expandedStandingsGroups = {};
        this.expandedStandingsGroups[grpKey] = !this.expandedStandingsGroups[grpKey];
        this.renderStandings();
    }

    /* ========================================================
       אלגוריתם 4: שיבוץ פלייאוף דינמי (נוקאאוט)
       ======================================================== */

    seedPlayoffs() {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        this.calculateStandings();

        const grpKeys = Object.keys(this.standings);
        if (grpKeys.length === 0) {
            this.showAlert("שגיאה בנתוני הבתים. יש לייצר לוח משחקים תחילה.", "error");
            return;
        }

        const playoffSize = this.playoffSize || (this.teams.length >= 8 ? 8 : 4);
        const groupHebrew = {
            'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
            'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
        };

        const sortPerformance = (a, b) => {
            if (b.pts !== a.pts) return b.pts - a.pts;
            if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
            if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
            if (b.wins !== a.wins) return b.wins - a.wins;
            return (a.teamName || '').localeCompare(b.teamName || '');
        };

        const allTeamsByRank = [];
        const maxRank = Math.max(...grpKeys.map(k => (this.standings[k] || []).length));

        for (let r = 0; r < maxRank; r++) {
            const rankTeams = [];
            grpKeys.forEach(k => {
                if (this.standings[k] && this.standings[k][r]) {
                    rankTeams.push({
                        ...this.standings[k][r],
                        origin: `מקום ${r + 1} ${groupHebrew[k] || k}`
                    });
                }
            });
            rankTeams.sort(sortPerformance);
            allTeamsByRank.push(...rankTeams);
        }

        const qualifiers = allTeamsByRank.slice(0, playoffSize);
        this.playoffSeeds = qualifiers.map((t, idx) => ({
            seed: idx + 1,
            ...t
        }));

        this.playoffMatches = this.buildInitialKnockoutBracket(this.playoffSeeds, playoffSize);

        this.renderPlayoffBracket();
        this.saveActiveTournamentData();
        this.switchTab('playoffs');
        this.showAlert(`שלב הבתים ננעל בהצלחה! ${playoffSize} הקבוצות המובילות שובצו לעץ הפלייאוף.`, "success");
    }

    renderPlayoffBracket() {
        const container = document.getElementById('playoff-bracket-container');
        if (!container) return;

        const isViewer = (this.currentRole === 'viewer') || this.isCurrentTournamentClosed();

        // קבוצות שהודחו: כל מי שהפסידה במשחק פלייאוף שהוכרע
        const eliminatedSeeds = new Set();
        const pm = this.playoffMatches || {};
        [...(pm.r16 || []), ...(pm.qf || []), ...(pm.sf || []), pm.final].forEach(m => {
            if (!m || (m.winner !== 'team1' && m.winner !== 'team2')) return;
            const loser = m.winner === 'team1' ? m.team2 : m.team1;
            if (loser) eliminatedSeeds.add(loser.seed);
        });

        const seedsSummaryHtml = (this.playoffSeeds && this.playoffSeeds.length > 0) ? `
            <div class="seed-summary-card">
                <div style="font-weight: 800; font-size: 1.05rem; margin-bottom: 6px; color:#271e16;">
                    🎯 ${this.playoffSeeds.length} הקבוצות המדורגות בפלייאוף:
                </div>
                <div class="seed-grid">
                    ${this.playoffSeeds.map(s => `
                        <div class="seed-chip ${eliminatedSeeds.has(s.seed) ? 'is-eliminated' : ''}" ${eliminatedSeeds.has(s.seed) ? 'title="הודחה מהטורניר"' : ''}>
                            <span style="font-weight: 700; color: #382c21;">
                                <span class="seed-badge">${s.seed}</span> ${s.teamName}
                            </span>
                            <span style="font-size: 0.78rem; color: #6b5b45;">
                                ${s.origin || ''}
                            </span>
                        </div>
                    `).join('')}
                </div>
            </div>
        ` : '';

        const r16 = this.playoffMatches?.r16 || [];
        const qf = this.playoffMatches?.qf || [];
        const sf = this.playoffMatches?.sf || [];
        const final = this.playoffMatches?.final || null;

        const renderPlayoffCard = (m, isFinal = false) => {
            if (!m) return '';
            const team1Name = m.team1 ? m.team1.teamName : 'ממתין לתוצאה...';
            const team2Name = m.team2 ? m.team2.teamName : 'ממתין לתוצאה...';
            const team1Seed = m.team1?.seed || m.seed1;
            const team2Seed = m.team2?.seed || m.seed2;

            const isRow1Winner = m.winner === 'team1';
            const isRow2Winner = m.winner === 'team2';
            const row1Winner = isRow1Winner ? 'winner' : '';
            const row2Winner = isRow2Winner ? 'winner' : '';

            const score1Val = m.score1 !== null ? m.score1 : '';
            const score2Val = m.score2 !== null ? m.score2 : '';
            const disabledInputs = isViewer || !m.team1 || !m.team2;

            const isTie = (m.score1 !== null && m.score2 !== null && m.score1 === m.score2);
            let statusBadge = '';
            if (isTie) {
                statusBadge = '<span class="match-status-pill status-tie" title="שוויון - נדרשת הכרעה">⚖️ שוויון</span>';
            } else if (m.winner) {
                statusBadge = '<span class="match-status-pill status-done">✓ הסתיים</span>';
            } else if (m.score1 !== null || m.score2 !== null) {
                statusBadge = '<span class="match-status-pill status-live">⏱️ משוחק</span>';
            } else if (m.team1 && m.team2) {
                statusBadge = '<span class="match-status-pill status-ready">מוכן למשחק</span>';
            } else {
                statusBadge = '<span class="match-status-pill status-waiting">ממתין לעולות</span>';
            }

            return `
                <div class="match-card playoff-match-card ${isFinal ? 'is-final' : ''} ${isTie ? 'playoff-tie-card' : ''}" id="playoff-card-${m.id}">
                    <div class="match-header" style="${isFinal ? 'background: linear-gradient(135deg, #b45309, #d97706); color: white;' : ''}">
                        <span class="match-header-title">${m.roundName}</span>
                        ${statusBadge}
                    </div>

                    <div class="match-teams-list">
                        <div class="match-team-row ${row1Winner}" id="prow-${m.id}-1">
                            <div class="team-meta-wrap">
                                ${team1Seed ? `<span class="challonge-seed-badge">#${team1Seed}</span>` : ''}
                                <span class="team-name" title="${team1Name}">
                                    ${isRow1Winner ? '<span class="winner-trophy-icon">🏆</span> ' : ''}${team1Name}
                                </span>
                            </div>
                            <div class="score-input-wrap">
                                ${isViewer ? `
                                    <span class="score-display-viewer ${isRow1Winner ? 'score-winner' : ''}">${score1Val !== '' ? score1Val : '-'}</span>
                                ` : `
                                    <input type="number" min="0" step="1" 
                                           id="playoff-score-${m.id}-1"
                                           class="score-input ${isTie ? 'score-tie' : ''} ${isRow1Winner ? 'score-winner' : ''}" 
                                           value="${score1Val}" 
                                           placeholder="-"
                                           ${disabledInputs ? 'disabled' : ''}
                                           oninput="app.handlePlayoffScore('${m.id}', 1, this.value, this)"
                                           onchange="app.checkPlayoffDrawOnBlur('${m.id}')">
                                `}
                            </div>
                        </div>

                        <div class="match-team-row ${row2Winner}" id="prow-${m.id}-2">
                            <div class="team-meta-wrap">
                                ${team2Seed ? `<span class="challonge-seed-badge">#${team2Seed}</span>` : ''}
                                <span class="team-name" title="${team2Name}">
                                    ${isRow2Winner ? '<span class="winner-trophy-icon">🏆</span> ' : ''}${team2Name}
                                </span>
                            </div>
                            <div class="score-input-wrap">
                                ${isViewer ? `
                                    <span class="score-display-viewer ${isRow2Winner ? 'score-winner' : ''}">${score2Val !== '' ? score2Val : '-'}</span>
                                ` : `
                                    <input type="number" min="0" step="1" 
                                           id="playoff-score-${m.id}-2"
                                           class="score-input ${isTie ? 'score-tie' : ''} ${isRow2Winner ? 'score-winner' : ''}" 
                                           value="${score2Val}" 
                                           placeholder="-"
                                           ${disabledInputs ? 'disabled' : ''}
                                           oninput="app.handlePlayoffScore('${m.id}', 2, this.value, this)"
                                           onchange="app.checkPlayoffDrawOnBlur('${m.id}')">
                                `}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        };

        // כרטיס מוקטן לעץ במובייל: שמות ותוצאות בלבד, הקשה פותחת את המשחק המלא
        const renderCompactCard = (m, isFinal = false) => {
            if (!m) return '';
            const isTie = (m.score1 !== null && m.score2 !== null && m.score1 === m.score2);
            const miniRow = (team, score, isWinner) => `
                <span class="mini-row ${isWinner ? 'winner' : ''} ${team ? '' : 'is-waiting'}">
                    <span class="mini-name">${team ? team.teamName : 'ממתין'}</span>
                    <span class="mini-score">${score !== null && score !== undefined ? score : '-'}</span>
                </span>
            `;
            return `
                <button type="button" class="bracket-mini-card ${isFinal ? 'is-final' : ''} ${isTie ? 'playoff-tie-card' : ''}"
                        onclick="app.openPlayoffMatch('${m.id}')">
                    ${miniRow(m.team1, m.score1, m.winner === 'team1')}
                    ${miniRow(m.team2, m.score2, m.winner === 'team2')}
                </button>
            `;
        };

        const isMobile = this.mobileQuery.matches;
        const renderTreeCard = isMobile ? renderCompactCard : renderPlayoffCard;

        let championBannerHtml = '';
        if (final && final.winner) {
            const championTeam = final.winner === 'team1' ? final.team1 : final.team2;
            championBannerHtml = `
                <div class="champion-banner">
                    <h3>🏆 אלופת הטורניר! 🏆</h3>
                    <div class="champ-name">${championTeam.teamName}</div>
                    <p style="margin: 0; color: #92400e; font-weight: 700;">
                        כל הכבוד לאלופה הגדולה על ניצחון מוחץ בטורניר!
                    </p>
                </div>
            `;
        }

        // עץ הפלייאוף: הסיבוב הראשון (העלים) משמאל, הגמר מימין
        const rounds = [];
        if (r16.length > 0) rounds.push({ title: '⚔️ שמינית גמר', matches: r16 });
        if (qf.length > 0) rounds.push({ title: '⚔️ רבע גמר', matches: qf });
        if (sf.length > 0) rounds.push({ title: '🔥 חצי גמר', matches: sf });
        if (final) rounds.push({ title: '👑 משחק הגמר', matches: [final], isFinal: true });

        // העץ נחשף בהדרגה, תמיד שכבה אחת קדימה: שני הסיבובים הראשונים מוצגים מההתחלה,
        // וכל סיבוב נוסף מופיע ברגע שבסיבוב שלפניו נקבע משחק עם שתי קבוצות ידועות.
        const visibleRounds = rounds.filter((r, idx) =>
            idx <= 1 || rounds[idx - 1].matches.some(m => m.team1 && m.team2));

        // קו חיבור יוצא ממשחק רק כאשר שתי הקבוצות המתמודדות בו כבר ידועות
        const isSet = (m) => !!(m && m.team1 && m.team2);

        const columnsHtml = visibleRounds.map((r, idx) => `
            <div class="bracket-round-column">
                <div class="round-header" style="${r.isFinal ? 'background:#b45309;' : ''}">${r.title}</div>
                <div class="bracket-round-matches">
                    ${r.matches.map((m, i) => {
                        const feeders = idx > 0 ? visibleRounds[idx - 1].matches.slice(i * 2, i * 2 + 2) : [];
                        const slotClasses = `${isSet(m) ? 'is-set' : ''} ${feeders.some(isSet) ? 'has-feed' : ''}`;
                        return `<div class="bracket-slot ${slotClasses}">${renderTreeCard(m, !!r.isFinal)}</div>`;
                    }).join('')}
                </div>
            </div>
        `);

        // שמירת מיקום הגלילה האופקית של העץ בין רינדורים (חשוב במובייל בזמן הזנת תוצאות)
        const prevScrollLeft = container.querySelector('.bracket-tree-scroll')?.scrollLeft || 0;

        // במובייל: המשחק שנבחר נפתח מעל העץ בכרטיס מלא (שמות מלאים והזנת תוצאה)
        const openMatch = (isMobile && this.openPlayoffMatchId) ? this.findPlayoffMatch(this.openPlayoffMatchId) : null;
        const editorHtml = openMatch ? `
            <div class="bracket-editor-backdrop" onclick="if (event.target === this) app.closePlayoffMatch()">
                <div class="bracket-editor">
                    ${renderPlayoffCard(openMatch, openMatch.id === 'final')}
                    <button type="button" class="btn-secondary" onclick="app.closePlayoffMatch()">סגור</button>
                </div>
            </div>
        ` : '';

        container.innerHTML = `
            ${seedsSummaryHtml}
            ${(isMobile && !isViewer) ? '<p class="bracket-mobile-hint">👆 הקש על משחק לצפייה בפרטים המלאים ולהזנת תוצאה</p>' : ''}
            <div class="bracket-tree-scroll">
                <div class="bracket-tree" style="--rounds: ${visibleRounds.length};">
                    ${columnsHtml.join('')}
                </div>
            </div>
            ${championBannerHtml}
            ${editorHtml}
        `;

        const treeScroll = container.querySelector('.bracket-tree-scroll');
        if (treeScroll) treeScroll.scrollLeft = prevScrollLeft;
    }

    openPlayoffMatch(matchId) {
        this.openPlayoffMatchId = matchId;
        this.renderPlayoffBracket();
    }

    closePlayoffMatch() {
        this.openPlayoffMatchId = null;
        this.renderPlayoffBracket();
    }

    findPlayoffMatch(matchId) {
        if (!this.playoffMatches) return null;
        if (matchId.startsWith('r16')) return this.playoffMatches.r16?.find(m => m.id === matchId);
        if (matchId.startsWith('qf')) return this.playoffMatches.qf?.find(m => m.id === matchId);
        if (matchId.startsWith('sf')) return this.playoffMatches.sf?.find(m => m.id === matchId);
        if (matchId === 'final') return this.playoffMatches.final;
        return null;
    }

    renderPlayoffBracketWithFocus(preferredId) {
        const activeEl = document.activeElement;
        const activeId = preferredId || (activeEl ? activeEl.id : null);
        let selStart = null;
        let selEnd = null;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
            try {
                selStart = activeEl.selectionStart;
                selEnd = activeEl.selectionEnd;
            } catch (e) {}
        }

        this.renderPlayoffBracket();

        if (activeId) {
            const restored = document.getElementById(activeId);
            if (restored) {
                restored.focus();
                if (selStart !== null && selEnd !== null && typeof restored.setSelectionRange === 'function') {
                    try {
                        restored.setSelectionRange(selStart, selEnd);
                    } catch (e) {}
                }
            }
        }
    }

    handlePlayoffScore(matchId, teamNum, rawValue, inputElement) {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול. לא ניתן לשנות תוצאות.", "warning");
            return;
        }

        let match = this.findPlayoffMatch(matchId);
        if (!match) return;

        if (rawValue === '' || rawValue === null || rawValue === undefined) {
            if (teamNum === 1) match.score1 = null;
            if (teamNum === 2) match.score2 = null;
            match.winner = null;
            this.propagatePlayoffWinner(match, null);
            this.renderPlayoffBracketWithFocus(inputElement?.id);
            this.saveActiveTournamentData();
            return;
        }

        const parsed = Number(rawValue);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
            // לא מוחקים את הקלט בזמן הקלדה רגילה
            return;
        }

        if (teamNum === 1) match.score1 = parsed;
        else match.score2 = parsed;

        if (match.score1 !== null && match.score2 !== null) {
            if (match.score1 === match.score2) {
                // תוצאת תיקו בפלייאוף היא שלב ביניים (למשל בהקלדת מספר דו-ספרתי 11 או בלחיצה על חצים)
                // לא מוחקים את הנתונים ולא מקפיצים שגיאה מפריעה!
                // פשוט לא מכריזים על מנצח עד שתושג הכרעה בתוצאה
                match.winner = null;
                this.propagatePlayoffWinner(match, null);
            } else {
                match.winner = match.score1 > match.score2 ? 'team1' : 'team2';
                const winnerTeam = match.winner === 'team1' ? match.team1 : match.team2;
                this.propagatePlayoffWinner(match, winnerTeam);
            }
        } else {
            match.winner = null;
            this.propagatePlayoffWinner(match, null);
        }

        this.renderPlayoffBracketWithFocus(inputElement?.id);
        this.saveActiveTournamentData();
    }

    checkPlayoffDrawOnBlur(matchId) {
        const match = this.findPlayoffMatch(matchId);
        if (match && match.score1 !== null && match.score2 !== null && match.score1 === match.score2) {
            this.showAlert("⚠️ שים לב: המשחק כרגע בתוצאת תיקו. בפלייאוף נדרשת הכרעה לקביעת העולה לשלב הבא.", "warning");
        }
    }

    propagatePlayoffWinner(match, winnerTeam) {
        if (!match.nextMatchId) return;

        let nextMatch = null;
        if (match.nextMatchId.startsWith('qf')) {
            nextMatch = this.playoffMatches.qf?.find(m => m.id === match.nextMatchId);
        } else if (match.nextMatchId.startsWith('sf')) {
            nextMatch = this.playoffMatches.sf?.find(m => m.id === match.nextMatchId);
        } else if (match.nextMatchId === 'final') {
            nextMatch = this.playoffMatches.final;
        }

        if (nextMatch) {
            if (match.nextSlot === 1) {
                nextMatch.team1 = winnerTeam;
                nextMatch.score1 = null;
            } else if (match.nextSlot === 2) {
                nextMatch.team2 = winnerTeam;
                nextMatch.score2 = null;
            }
            nextMatch.winner = null;
            this.propagatePlayoffWinner(nextMatch, null);
        }
    }

    fillSampleScores() {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        if (this.isGroupStageLocked()) {
            this.showAlert("שלב הבתים כבר ננעל ושובץ לפלייאוף. לא ניתן להזין תוצאות דוגמה לשלב הבתים.", "warning");
            return;
        }

        if (this.format === 'knockout_only') {
            this.simulatePlayoffs();
            return;
        }

        this.matches.forEach(m => {
            let s1 = 60 + Math.floor(Math.random() * 40);
            let s2 = 60 + Math.floor(Math.random() * 40);
            // אפשרות של כ-20% לתוצאת תיקו לבדיקת שיטת הניקוד ושוברי השוויון
            if (Math.random() < 0.2) s2 = s1;
            m.score1 = s1;
            m.score2 = s2;
            if (s1 === s2) {
                m.winner = 'draw';
            } else {
                m.winner = s1 > s2 ? 'team1' : 'team2';
            }
        });

        this.renderMatches();
        this.calculateStandings();
        this.saveActiveTournamentData();
        this.showAlert(`הוזנו תוצאות לדוגמה לכל ${this.matches.length} המשחקים!`, "success");
    }

    resetAllScores() {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        if (this.isGroupStageLocked()) {
            this.showAlert("שלב הבתים ננעל ושובץ לפלייאוף. יש לאפס את הפלייאוף תחילה כדי לאפס את תוצאות שלב הבתים.", "warning");
            return;
        }

        this.matches.forEach(m => {
            m.score1 = null;
            m.score2 = null;
            m.winner = null;
        });

        this.renderMatches();
        this.calculateStandings();
        this.saveActiveTournamentData();
        this.showAlert("כל תוצאות המשחקים אופסו בהצלחה.", "warning");
    }

    simulatePlayoffs() {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        if (!this.playoffMatches) return;

        const simulateRound = (roundMatches) => {
            if (!Array.isArray(roundMatches)) return;
            roundMatches.forEach(m => {
                if (m.team1 && m.team2) {
                    const s1 = 70 + Math.floor(Math.random() * 30);
                    let s2 = 70 + Math.floor(Math.random() * 30);
                    if (s1 === s2) s2 += 2;
                    m.score1 = s1; m.score2 = s2;
                    m.winner = s1 > s2 ? 'team1' : 'team2';
                    const winnerTeam = m.winner === 'team1' ? m.team1 : m.team2;
                    this.propagatePlayoffWinner(m, winnerTeam);
                }
            });
        };

        if (this.playoffMatches.r16) simulateRound(this.playoffMatches.r16);
        if (this.playoffMatches.qf) simulateRound(this.playoffMatches.qf);
        if (this.playoffMatches.sf) simulateRound(this.playoffMatches.sf);

        const final = this.playoffMatches.final;
        if (final && final.team1 && final.team2) {
            const s1 = 80 + Math.floor(Math.random() * 20);
            let s2 = 80 + Math.floor(Math.random() * 20);
            if (s1 === s2) s2 += 1;
            final.score1 = s1; final.score2 = s2;
            final.winner = s1 > s2 ? 'team1' : 'team2';
        }

        this.renderPlayoffBracket();
        this.saveActiveTournamentData();
        this.showAlert("כל משחקי הפלייאוף סומלצו עד להכתרת האלופה!", "success");
    }

    resetPlayoffs() {
        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        if (!this.playoffSeeds || this.playoffSeeds.length === 0) return;
        this.seedPlayoffs();
    }

    hardReset() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לאפס את הטורניר לחלוטין!", "error");
            return;
        }

        if (this.isCurrentTournamentClosed()) {
            this.showAlert("הטורניר סגור ונעול לעריכה.", "warning");
            return;
        }

        this.teams = [...this.defaultTeams];
        this.renderTeamInputs();
        this.generateTournamentGroups(false);
        this.playoffSeeds = [];
        const playoffContainer = document.getElementById('playoff-bracket-container');
        if (playoffContainer) {
            playoffContainer.innerHTML = '<p class="placeholder-text">שלב הפלייאוף יופעל רק לאחר סיום שלב הבתים ונעילתו ע"י האדמין.</p>';
        }
        this.saveActiveTournamentData();
        this.switchTab('setup');
        this.showAlert("הטורניר אופס לחלוטין למצב התחלתי!", "warning");
    }

    /* ========================================================
       ייצוא נתונים: CSV (Excel) ו-Markdown (GitHub)
       ======================================================== */

    exportToCSV() {
        this.calculateStandings();

        const escapeCSV = (val) => {
            if (val === null || val === undefined) return '""';
            const str = String(val);
            return `"${str.replace(/"/g, '""')}"`;
        };

        const rows = [];
        rows.push([escapeCSV("🏆 טורנירשת - נתוני טורניר וטבלאות דירוג")]);
        const currentTourney = this.tournaments.find(t => t.id === this.activeTournamentId);
        rows.push([escapeCSV("שם טורניר"), escapeCSV(currentTourney?.name || "טורניר פעיל")]);
        const formatLabel = (this.format === 'knockout_only') ? 'נוקאאוט בלבד' :
                            (this.format === 'groups_only') ? 'שלב בתים בלבד' : 'בתים + פלייאוף';
        rows.push([escapeCSV("מבנה טורניר"), escapeCSV(formatLabel)]);
        rows.push([escapeCSV("תאריך הפקה"), escapeCSV(new Date().toLocaleString('he-IL'))]);
        rows.push([]);

        if (this.format !== 'knockout_only' && this.standings) {
            rows.push([escapeCSV("=== טבלאות דירוג שלב הבתים ===")]);
            rows.push([
                escapeCSV("בית"), escapeCSV("מיקום"), escapeCSV("קבוצה"),
                escapeCSV("משחקים שוחקו"), escapeCSV("ניצחונות"), escapeCSV("תיקו"), escapeCSV("הפסדים"),
                escapeCSV("נקודות זכות"), escapeCSV("נקודות חובה"), escapeCSV("הפרש נקודות"),
                escapeCSV("נקודות ליגה"), escapeCSV("סטטוס")
            ]);

            const groupLabels = { 'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'", 'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'" };
            for (const [grpKey, stats] of Object.entries(this.standings)) {
                stats.forEach(s => {
                    let statusText = (this.format === 'groups_only')
                        ? (s.groupRank === 1 ? "🏆 אלופת הבית (מקום 1)" : `מקום ${s.groupRank}`)
                        : (s.groupRank <= 2 ? "עולה ישירה (Top 2)" : s.groupRank === 3 ? "מועמדת לעלייה (מקום 3)" : "הודחה");

                    rows.push([
                        escapeCSV(groupLabels[grpKey] || grpKey), escapeCSV(s.groupRank), escapeCSV(s.teamName),
                        escapeCSV(s.played), escapeCSV(s.wins), escapeCSV(s.draws || 0), escapeCSV(s.losses),
                        escapeCSV(s.pointsFor), escapeCSV(s.pointsAgainst),
                        escapeCSV(s.pointDiff > 0 ? `+${s.pointDiff}` : s.pointDiff),
                        escapeCSV(s.pts || 0),
                        escapeCSV(statusText)
                    ]);
                });
            }
            rows.push([]);

            rows.push([escapeCSV(`=== תוצאות ולוח משחקי שלב הבתים (${this.matches.length} משחקים) ===`)]);
            rows.push([
                escapeCSV("מספר משחק"), escapeCSV("בית"), escapeCSV("מחזור"),
                escapeCSV("קבוצה 1"), escapeCSV("תוצאה 1"), escapeCSV("תוצאה 2"),
                escapeCSV("קבוצה 2"), escapeCSV("מנצחת המשחק"), escapeCSV("סטטוס משחק")
            ]);

            this.matches.forEach(m => {
                const hasScores = m.score1 !== null && m.score2 !== null;
                const score1Str = hasScores ? m.score1 : "";
                const score2Str = hasScores ? m.score2 : "";
                let winnerStr = "";
                let statusStr = "טרם שוחק";
                if (hasScores && m.winner) {
                    if (m.winner === 'draw') {
                        winnerStr = "תיקו 🤝";
                    } else {
                        winnerStr = m.winner === 'team1' ? m.team1Name : m.team2Name;
                    }
                    statusStr = "הסתיים";
                }
                rows.push([
                    escapeCSV(m.matchNumber), escapeCSV(m.groupNameHe), escapeCSV(`מחזור ${m.round}`),
                    escapeCSV(m.team1Name), escapeCSV(score1Str), escapeCSV(score2Str),
                    escapeCSV(m.team2Name), escapeCSV(winnerStr), escapeCSV(statusStr)
                ]);
            });
            rows.push([]);
        }

        rows.push([escapeCSV("=== שלב הפלייאוף (נוקאאוט) ===")]);
        if (this.playoffSeeds && this.playoffSeeds.length > 0) {
            rows.push([escapeCSV("--- קבוצות מדורגות ---")]);
            rows.push([escapeCSV("דירוג"), escapeCSV("שם קבוצה"), escapeCSV("מקור העפלה"), escapeCSV("ניצחונות"), escapeCSV("הפרש")]);
            this.playoffSeeds.forEach(s => {
                rows.push([
                    escapeCSV(`דירוג ${s.seed}`), escapeCSV(s.teamName),
                    escapeCSV(s.origin || `מקום בבית`), escapeCSV(s.wins || 0),
                    escapeCSV(s.pointDiff > 0 ? `+${s.pointDiff}` : (s.pointDiff || 0))
                ]);
            });
            rows.push([]);
        }

        if (this.playoffMatches) {
            rows.push([escapeCSV("--- משחקי פלייאוף ותוצאות ---")]);
            rows.push([escapeCSV("שלב"), escapeCSV("משחק"), escapeCSV("קבוצה 1"), escapeCSV("תוצאה 1"), escapeCSV("תוצאה 2"), escapeCSV("קבוצה 2"), escapeCSV("מנצחת / מעפילה")]);

            ['r16', 'qf', 'sf'].forEach(roundKey => {
                const matches = this.playoffMatches[roundKey];
                if (Array.isArray(matches)) {
                    matches.forEach(m => {
                        const s1 = m.score1 !== null ? m.score1 : "";
                        const s2 = m.score2 !== null ? m.score2 : "";
                        const win = m.winner ? (m.winner === 'team1' ? m.team1?.teamName : m.team2?.teamName) : "ממתין להכרעה";
                        rows.push([escapeCSV(roundKey.toUpperCase()), escapeCSV(m.roundName), escapeCSV(m.team1?.teamName || "ממתין"), escapeCSV(s1), escapeCSV(s2), escapeCSV(m.team2?.teamName || "ממתין"), escapeCSV(win)]);
                    });
                }
            });

            if (this.playoffMatches.final) {
                const fn = this.playoffMatches.final;
                const s1 = fn.score1 !== null ? fn.score1 : "";
                const s2 = fn.score2 !== null ? fn.score2 : "";
                const win = fn.winner ? (fn.winner === 'team1' ? fn.team1?.teamName : fn.team2?.teamName) : "ממתין להכרעה";
                rows.push([escapeCSV("גמר"), escapeCSV(fn.roundName), escapeCSV(fn.team1?.teamName || "ממתין"), escapeCSV(s1), escapeCSV(s2), escapeCSV(fn.team2?.teamName || "ממתין"), escapeCSV(win)]);
                if (fn.winner) {
                    const champ = fn.winner === 'team1' ? fn.team1?.teamName : fn.team2?.teamName;
                    rows.push([]);
                    rows.push([escapeCSV("🏆 אלופת הטורניר"), escapeCSV(champ)]);
                }
            }
        }


        const csvContent = '\uFEFF' + rows.map(r => r.join(',')).join('\r\n');
        try {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const downloadLink = document.createElement('a');
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10);
            downloadLink.href = url;
            downloadLink.setAttribute('download', `tournament_data_${dateStr}.csv`);
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(url);
            this.showAlert("קובץ CSV הורד בהצלחה! ניתן לפתוח ישירות ב-Excel או Google Sheets.", "success");
        } catch (err) {
            console.error("Failed to download CSV:", err);
            this.showAlert("שגיאה בהורדת קובץ CSV.", "error");
        }

        return csvContent;
    }

    exportToGitHub() {
        this.calculateStandings();
        const currentTourney = this.tournaments.find(t => t.id === this.activeTournamentId);

        let md = `# 🏆 טורנירשת - Two-Stage Tournament Manager\n\n`;
        md += `טורניר: **${currentTourney?.name || "טורניר פעיל"}**\n\n`;
        md += `אפליקציית Web לניהול מלא של טורניר 15 קבוצות (3 בתים של 5 קבוצות, לוח Round-Robin בן 30 משחקים, אימות איסור תיקו, ופלייאוף נוקאאוט Top 8).\n\n`;
        md += `> תאריך יצירת הדוח: ${new Date().toLocaleString('he-IL')}\n\n`;
        md += `---\n\n`;

        md += `## 👥 הרכב הבתים והקבוצות\n\n`;
        const groupLabels = { 'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'" };
        for (const [grpKey, grpLabel] of Object.entries(groupLabels)) {
            md += `### ${grpLabel}\n`;
            const grpTeams = this.groups[grpKey] || [];
            grpTeams.forEach((t, i) => {
                md += `${i + 1}. **${this.teams[t.index]}**\n`;
            });
            md += `\n`;
        }

        md += `## 📊 טבלאות דירוג נוכחיות\n\n`;
        for (const [grpKey, grpLabel] of Object.entries(groupLabels)) {
            md += `### ${grpLabel}\n\n`;
            md += `| מיקום | קבוצה | משחקים | ניצחונות | הפסדים | נקודות זכות | נקודות חובה | הפרש |\n`;
            md += `| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: |\n`;
            const stats = this.standings[grpKey] || [];
            stats.forEach(s => {
                const diffStr = s.pointDiff > 0 ? `+${s.pointDiff}` : `${s.pointDiff}`;
                const qualifyBadge = s.groupRank <= 2 ? ' ⭐' : s.groupRank === 3 ? ' 🔸' : '';
                md += `| ${s.groupRank} | **${s.teamName}**${qualifyBadge} | ${s.played} | ${s.wins} | ${s.losses} | ${s.pointsFor} | ${s.pointsAgainst} | ${diffStr} |\n`;
            });
            md += `\n`;
        }

        md += `## 📅 לוח ותוצאות משחקי שלב הבתים (30 משחקים)\n\n`;
        md += `| # | בית | מחזור | מפגש | תוצאה | סטטוס |\n`;
        md += `| :-: | :-- | :-: | :-- | :-: | :-- |\n`;
        this.matches.forEach(m => {
            const hasScore = m.score1 !== null && m.score2 !== null;
            const scoreStr = hasScore ? `**${m.score1} - ${m.score2}**` : `-`;
            let winnerStr = `טרם שוחק`;
            if (hasScore && m.winner) {
                const winnerName = m.winner === 'team1' ? m.team1Name : m.team2Name;
                winnerStr = `🏆 ${winnerName}`;
            }
            md += `| ${m.matchNumber} | ${m.groupNameHe} | מחזור ${m.round} | ${m.team1Name} נגד ${m.team2Name} | ${scoreStr} | ${winnerStr} |\n`;
        });
        md += `\n`;

        md += `## 🌳 שלב הפלייאוף (8 הגדולות)\n\n`;
        if (this.playoffSeeds && this.playoffSeeds.length === 8) {
            md += `### 🎯 8 הקבוצות המדורגות לפלייאוף:\n\n`;
            this.playoffSeeds.forEach(s => {
                md += `- **דירוג ${s.seed}:** ${s.teamName} (${s.wins} ניצחונות, הפרש ${s.pointDiff > 0 ? '+' : ''}${s.pointDiff})\n`;
            });
            md += `\n`;

            md += `### משחקי רבע הגמר:\n`;
            this.playoffMatches.qf.forEach(qf => {
                const score = (qf.score1 !== null && qf.score2 !== null) ? `${qf.score1} - ${qf.score2}` : `טרם שוחק`;
                const winner = qf.winner ? ` (מנצחת: ${qf.winner === 'team1' ? qf.team1.teamName : qf.team2.teamName} 🏆)` : '';
                md += `- **${qf.roundName}:** ${qf.team1.teamName} (דירוג ${qf.seed1}) נגד ${qf.team2.teamName} (דירוג ${qf.seed2}) | **${score}**${winner}\n`;
            });
            md += `\n`;

            md += `### משחקי חצי הגמר:\n`;
            this.playoffMatches.sf.forEach(sf => {
                const t1 = sf.team1 ? sf.team1.teamName : 'ממתין';
                const t2 = sf.team2 ? sf.team2.teamName : 'ממתין';
                const score = (sf.score1 !== null && sf.score2 !== null) ? `${sf.score1} - ${sf.score2}` : `טרם שוחק`;
                const winner = sf.winner ? ` (מנצחת: ${sf.winner === 'team1' ? sf.team1.teamName : sf.team2.teamName} 🏆)` : '';
                md += `- **${sf.roundName}:** ${t1} נגד ${t2} | **${score}**${winner}\n`;
            });
            md += `\n`;

            if (this.playoffMatches.final) {
                const fn = this.playoffMatches.final;
                const t1 = fn.team1 ? fn.team1.teamName : 'ממתין';
                const t2 = fn.team2 ? fn.team2.teamName : 'ממתין';
                const score = (fn.score1 !== null && fn.score2 !== null) ? `${fn.score1} - ${fn.score2}` : `טרם שוחק`;
                const winner = fn.winner ? ` (🏆 אלופה: ${fn.winner === 'team1' ? fn.team1.teamName : fn.team2.teamName}!)` : '';
                md += `### 🏆 משחק הגמר:\n`;
                md += `- ${t1} נגד ${t2} | **${score}**${winner}\n\n`;
            }
        }

        md += `---\n\n`;
        md += `## 🚀 מדריך העלאת הפרויקט ל-GitHub (Git Commands Guide)\n\n`;
        md += `\`\`\`bash\n`;
        md += `git init\n`;
        md += `git add .\n`;
        md += `git commit -m "Initial commit: Two-Stage Tournament Manager"\n`;
        md += `git branch -M main\n`;
        md += `git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git\n`;
        md += `git push -u origin main\n`;
        md += `\`\`\`\n`;

        try {
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const downloadLink = document.createElement('a');
            downloadLink.href = url;
            downloadLink.setAttribute('download', 'README.md');
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error("Failed to trigger automatic download:", err);
        }

        this.openGitHubModal();
        this.showAlert("קובץ README.md נוצר והורד למחשבך בהצלחה!", "success");
        return md;
    }

    openGitHubModal() {
        const modal = document.getElementById('github-modal');
        if (modal) modal.classList.remove('hidden');
    }

    closeGitHubModal() {
        const modal = document.getElementById('github-modal');
        if (modal) modal.classList.add('hidden');
    }

    copyGitCommands() {
        const gitCommands = `git init\ngit add .\ngit commit -m "Initial commit: Two-Stage Tournament Manager"\ngit branch -M main\ngit remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO_NAME>.git\ngit push -u origin main`;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(gitCommands).then(() => {
                this.showAlert("פקודות Git הועתקו ללוח בהצלחה!", "success");
            }).catch(() => {
                this.showAlert("אנא העתק את הפקודות ידנית מתוך תיבת הטקסט.", "warning");
            });
        } else {
            this.showAlert("אנא סמן והעתק את הטקסט מתוך התיבה.", "warning");
        }
    }

    openProfileModal() {
        if (!this.currentUser) return;
        const modal = document.getElementById('profile-modal');
        const emailDisp = document.getElementById('profileEmailDisplay');
        const nameInput = document.getElementById('profileNameInput');
        const curPass = document.getElementById('profileCurrentPassword');
        const newPass = document.getElementById('profileNewPassword');

        const user = this.getUserByEmail(this.currentUser.email);
        if (emailDisp) emailDisp.value = this.currentUser.email || '';
        // נלקח נקי לחלוטין מתוך user.name ללא שום מניפולציית מחרוזת פגומה!
        if (nameInput) nameInput.value = user ? user.name : (this.currentUser.name || '');
        if (curPass) curPass.value = '';
        if (newPass) newPass.value = '';

        if (modal) modal.classList.remove('hidden');
    }

    closeProfileModal() {
        const modal = document.getElementById('profile-modal');
        if (modal) modal.classList.add('hidden');
    }

    saveProfileChanges() {
        if (!this.currentUser) return;
        const nameInput = document.getElementById('profileNameInput');
        const curPassInput = document.getElementById('profileCurrentPassword');
        const newPassInput = document.getElementById('profileNewPassword');

        const newName = nameInput ? nameInput.value.trim() : '';
        const curPass = curPassInput ? curPassInput.value.trim() : '';
        const newPass = newPassInput ? newPassInput.value.trim() : '';
        const email = this.currentUser.email.toLowerCase();

        const user = this.getUserByEmail(email);
        if (!user) {
            this.showAlert("שגיאה במציאת פרטי המשתמש.", "error");
            return;
        }

        // אימות סיסמה נוכחית אם המשתמש מנסה לשנות סיסמה
        if (newPass) {
            if (newPass.length < 4) {
                this.showAlert("סיסמה חדשה חייבת להכיל לפחות 4 תווים.", "error");
                return;
            }
            if (curPass !== user.password) {
                this.showAlert("הסיסמה הנוכחית שהזנת שגויה.", "error");
                return;
            }
            user.password = newPass;
        }

        // עדכון שם
        if (newName) {
            user.name = newName;
            this.currentUser.name = newName;
            const role = this.currentUser.role;
            if (role === 'owner') this.currentUser.displayName = `👑 בעלים (${newName})`;
            else if (role === 'admin') this.currentUser.displayName = `⚡ מנהל (${newName})`;
            else this.currentUser.displayName = `👁️ ${newName}`;

            sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));
            this.updateUserSessionUI();
        }

        const users = this.getUnifiedUsers();
        const idx = users.findIndex(u => u.email.toLowerCase() === email);
        if (idx !== -1) {
            users[idx] = user;
            this.saveUnifiedUsers(users);
        }

        this.closeProfileModal();
        this.renderUsersManagement();
        this.showAlert("פרטי הפרופיל והסיסמה עודכנו בהצלחה!", "success");
    }

    /* ========================================================
       התאמת צפייה אישית לאורח / צופה (Guest Following)
       ======================================================== */

    openGuestPreferencesModal() {
        const modal = document.getElementById('guest-preferences-modal');
        if (!modal) return;

        this.populateGuestPrefTourneySelect();
        this.updateGuestPrefHousesAndTeams();

        modal.classList.remove('hidden');
    }

    closeGuestPreferencesModal() {
        const modal = document.getElementById('guest-preferences-modal');
        if (modal) modal.classList.add('hidden');
    }

    populateGuestPrefTourneySelect() {
        const select = document.getElementById('guestPrefTourneySelect');
        if (!select) return;

        const currentId = this.guestPreferences?.tourneyId || this.activeTournamentId;
        select.innerHTML = this.tournaments.map(t => {
            const formatLabel = (t.format === 'knockout_only') ? 'נוקאאוט' : ((t.format === 'groups_only') ? 'בתים בלבד' : 'בתים+פלייאוף');
            return `
                <option value="${t.id}" ${t.id === currentId ? 'selected' : ''}>
                    ${t.name} (${formatLabel}) ${t.isArchived ? '[ארכיון]' : ''}
                </option>
            `;
        }).join('');
    }

    onGuestPrefTourneyChange(tourneyId) {
        this.updateGuestPrefHousesAndTeams(tourneyId);
    }

    updateGuestPrefHousesAndTeams(selectedTourneyId) {
        const tourneyId = selectedTourneyId || document.getElementById('guestPrefTourneySelect')?.value || this.activeTournamentId;
        const tourney = this.tournaments.find(t => t.id === tourneyId) || this.tournaments[0];
        if (!tourney) return;

        const houseGroup = document.getElementById('guestPrefHouseGroup');
        const houseSelect = document.getElementById('guestPrefHouseSelect');

        const groupHebrewMap = {
            'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
            'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
        };

        if (tourney.format === 'knockout_only') {
            if (houseGroup) houseGroup.classList.add('hidden');
        } else {
            if (houseGroup) houseGroup.classList.remove('hidden');
            if (houseSelect) {
                let groupKeys = (tourney.groups && Object.keys(tourney.groups).length > 0)
                    ? Object.keys(tourney.groups)
                    : [];

                if (groupKeys.length === 0) {
                    const n = tourney.numGroups || 3;
                    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
                    groupKeys = letters.slice(0, n).map(l => `Group ${l}`);
                }

                const selectedGroup = (this.guestPreferences?.tourneyId === tourneyId) ? (this.guestPreferences?.groupKey || 'all') : 'all';
                houseSelect.innerHTML = `
                    <option value="all" ${selectedGroup === 'all' ? 'selected' : ''}>כל הבתים (ללא סינון בית)</option>
                    ${groupKeys.map(k => `
                        <option value="${k}" ${selectedGroup === k ? 'selected' : ''}>${groupHebrewMap[k] || k}</option>
                    `).join('')}
                `;
            }
        }

        this.updateGuestPrefTeams(tourneyId);
    }

    onGuestPrefHouseChange() {
        const tourneyId = document.getElementById('guestPrefTourneySelect')?.value || this.activeTournamentId;
        this.updateGuestPrefTeams(tourneyId);
    }

    updateGuestPrefTeams(selectedTourneyId) {
        const tourneyId = selectedTourneyId || document.getElementById('guestPrefTourneySelect')?.value || this.activeTournamentId;
        const tourney = this.tournaments.find(t => t.id === tourneyId) || this.tournaments[0];
        const teamSelect = document.getElementById('guestPrefTeamSelect');
        const houseSelect = document.getElementById('guestPrefHouseSelect');
        if (!teamSelect || !tourney) return;

        const selectedHouse = houseSelect ? houseSelect.value : 'all';
        let teamsToDisplay = [];

        if (tourney.groups && selectedHouse !== 'all' && tourney.groups[selectedHouse]) {
            teamsToDisplay = tourney.groups[selectedHouse].map(t => t.name || t);
        } else if (tourney.teams && tourney.teams.length > 0) {
            teamsToDisplay = [...tourney.teams];
        } else {
            teamsToDisplay = [...this.defaultTeams];
        }

        const currentTeam = (this.guestPreferences?.tourneyId === tourneyId) ? (this.guestPreferences?.teamName || '') : '';

        teamSelect.innerHTML = `
            <option value="">ללא קבוצה מועדפת (הצג הכל כרגיל)</option>
            ${teamsToDisplay.map(name => `
                <option value="${name}" ${name === currentTeam ? 'selected' : ''}>⚽ ${name}</option>
            `).join('')}
        `;
    }

    saveAndApplyGuestPreferences() {
        const tourneySelect = document.getElementById('guestPrefTourneySelect');
        const houseSelect = document.getElementById('guestPrefHouseSelect');
        const teamSelect = document.getElementById('guestPrefTeamSelect');

        const tourneyId = tourneySelect ? tourneySelect.value : this.activeTournamentId;
        const groupKey = houseSelect ? houseSelect.value : 'all';
        const teamName = teamSelect ? teamSelect.value.trim() : '';

        this.guestPreferences = {
            tourneyId,
            groupKey,
            teamName
        };
        localStorage.setItem('tournament_guest_pref', JSON.stringify(this.guestPreferences));

        // מעבר לטורניר הנבחר אם הוא שונה מהפעיל
        if (tourneyId !== this.activeTournamentId) {
            this.switchTournament(tourneyId, false);
        }

        // הגדרת סינון בית
        if (groupKey && groupKey !== 'all') {
            this.currentFilter = groupKey;
        } else {
            this.currentFilter = 'all';
        }

        this.closeGuestPreferencesModal();
        this.renderGuestFollowedBanner();
        this.renderStandings();
        this.renderMatches();

        const targetTab = (this.format === 'knockout_only') ? 'playoffs' : 'group-stage';
        this.switchTab(targetTab);

        if (teamName) {
            this.showAlert(`המעקב הופעל בהצלחה עבור קבוצת ${teamName}! טבלת הבית ומשחקי הקבוצה מוצגים ראשונים.`, "success");
        } else {
            this.showAlert("העדפות הצפייה נשמרו בהצלחה.", "success");
        }
    }

    clearGuestPreferences() {
        this.guestPreferences = null;
        localStorage.removeItem('tournament_guest_pref');
        this.currentFilter = 'all';

        this.renderGuestFollowedBanner();
        this.renderStandings();
        this.renderMatches();

        this.showAlert("המעקב האישי בוטל. מוצגים כל המשחקים והטבלאות כרגיל.", "info");
    }

    renderGuestFollowedBanner() {
        const bannerEl = document.getElementById('guest-followed-banner');
        if (!bannerEl) return;

        if (!this.guestPreferences || (!this.guestPreferences.teamName && (!this.guestPreferences.groupKey || this.guestPreferences.groupKey === 'all'))) {
            bannerEl.classList.add('hidden');
            return;
        }

        const groupHebrewMap = {
            'all': 'כל הבתים',
            'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'",
            'Group D': "בית ד'", 'Group E': "בית ה'", 'Group F': "בית ו'"
        };

        const teamText = this.guestPreferences.teamName ? `קבוצה: <strong>${this.guestPreferences.teamName}</strong>` : '';
        const houseText = (this.guestPreferences.groupKey && this.guestPreferences.groupKey !== 'all')
            ? `בית: <strong>${groupHebrewMap[this.guestPreferences.groupKey] || this.guestPreferences.groupKey}</strong>`
            : '';
        const sep = (teamText && houseText) ? ' • ' : '';

        bannerEl.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <span>⭐ <strong>מעקב צפייה אישי פעיל:</strong></span>
                <span>${teamText}${sep}${houseText}</span>
            </div>
            <div class="guest-banner-actions">
                <button type="button" class="btn-sm btn-secondary" onclick="app.openGuestPreferencesModal()">✏️ החלף מעקב</button>
                <button type="button" class="btn-sm" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-weight:700; border-radius:6px; cursor:pointer;" onclick="app.clearGuestPreferences()">✖️ נקה מעקב</button>
            </div>
        `;
        bannerEl.classList.remove('hidden');
    }
}

// אתחול האפליקציה ושמירתה על אובייקט ה-window לשימוש נוח מתוך קריאות HTML
const app = new TournamentApp();
window.app = app;
window.TournamentApp = TournamentApp;
window.exportToGitHub = () => app.exportToGitHub();
window.exportToCSV = () => app.exportToCSV();

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
        app.init();
    });
} else {
    app.init();
}
