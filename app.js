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

class TournamentApp {
    constructor() {
        this.GOOGLE_CLIENT_ID = "567782172017-trcbislv7ln6aunie8islslkgitl3g96.apps.googleusercontent.com";
        this.OWNER_EMAIL = "noamsee@gmail.com";
        this.currentRole = 'viewer';
        this.currentUser = null;

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

        // רשימת מנהלים מורשים (Admins) נשמרת ב-localStorage
        this.adminsList = this.loadAdmins();

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
        this.alertTimeout = null;
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

        // אתחול Google Identity Services (Sign-In with Google)
        this.initGoogleIdentityServices();

        // הצגת מסך הלוגין כברירת מחדל
        this.showLoginScreen();
    }

    initGoogleIdentityServices() {
        const checkGoogleScript = () => {
            if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
                try {
                    google.accounts.id.initialize({
                        client_id: this.GOOGLE_CLIENT_ID,
                        callback: (response) => this.handleGoogleCredentialResponse(response),
                        auto_select: false,
                        cancel_on_tap_outside: true
                    });

                    // רינדור כפתור Google Sign-In רשמי במיכל הייעודי
                    const container = document.getElementById('g_id_signin_container');
                    if (container) {
                        google.accounts.id.renderButton(container, {
                            theme: 'outline',
                            size: 'large',
                            type: 'standard',
                            text: 'signin_with',
                            shape: 'rectangular',
                            logo_alignment: 'left',
                            width: 320
                        });
                    }

                    // הצגת One Tap למשתמש
                    google.accounts.id.prompt();
                } catch (err) {
                    console.warn('[GIS] Error initializing Google Sign-In:', err);
                }
            } else {
                setTimeout(checkGoogleScript, 200);
            }
        };
        checkGoogleScript();
    }

    handleGoogleCredentialResponse(response) {
        if (!response || !response.credential) {
            this.showAlert("שגיאה בקבלת אימות מ-Google.", "error");
            return;
        }

        try {
            // פענוח ה-JWT ID Token ישירות בדפדפן
            const base64Url = response.credential.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));

            const payload = JSON.parse(jsonPayload);
            const email = (payload.email || '').toLowerCase();
            const name = payload.name || payload.given_name || email.split('@')[0];
            const picture = payload.picture || '';

            if (!email) {
                this.showAlert("לא התקבלה כתובת אימייל מאומתת מחשבון Google.", "error");
                return;
            }

            // סגירת המודאל אם היה פתוח
            this.closeGoogleAuthModal();

            this.showAlert(`ברוך הבא ${name}! התחברת בהצלחה עם Google (${email})`, "success");
            this.authenticateUser(email, true, name, 'google');

            // שמירת תמונת הפרופיל של Google ב-currentUser
            if (this.currentUser && picture) {
                this.currentUser.picture = picture;
                sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));
                this.updateUserSessionUI();
            }
        } catch (err) {
            console.error('[GIS] Failed to parse Google credential:', err);
            this.showAlert("שגיאה בפענוח אימות Google.", "error");
        }
    }

    triggerRealGoogleSignIn() {
        if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
            // בדיקה האם ניתן לפתוח את One Tap / בחירת חשבון ישירות
            google.accounts.id.prompt((notification) => {
                if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                    // אם ה-One Tap נחסם (למשל עוגיות צד שלישי או חוסם פרסומות), נפתח את המודאל הידידותי
                    this.openGoogleAuthModal();
                }
            });
        } else {
            this.openGoogleAuthModal();
        }
    }

    /* ========================================================
       ניהול אימות, כניסה והרשאות (Login & Personas)
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
       ניהול אימות, הרשמה, כניסה ו-Google Auth (Login & Sign-Up)
       ======================================================== */

    switchAuthMode(mode = 'login') {
        this.currentAuthMode = mode;
        const tabLogin = document.getElementById('tabBtnLogin');
        const tabSignup = document.getElementById('tabBtnSignup');
        const formLogin = document.getElementById('form-login');
        const formSignup = document.getElementById('form-signup');
        const googleAuthBtnText = document.getElementById('googleAuthBtnText');
        const authDividerText = document.getElementById('authDividerText');

        if (mode === 'signup') {
            if (tabLogin) { tabLogin.classList.remove('active'); tabLogin.setAttribute('aria-selected', 'false'); }
            if (tabSignup) { tabSignup.classList.add('active'); tabSignup.setAttribute('aria-selected', 'true'); }
            if (formLogin) formLogin.classList.add('hidden');
            if (formSignup) formSignup.classList.remove('hidden');
            if (googleAuthBtnText) googleAuthBtnText.textContent = 'הרשמה מהירה באמצעות Google / Gmail';
            if (authDividerText) authDividerText.textContent = 'או הרשמה באמצעות כתובת אימייל';
        } else {
            if (tabLogin) { tabLogin.classList.add('active'); tabLogin.setAttribute('aria-selected', 'true'); }
            if (tabSignup) { tabSignup.classList.remove('active'); tabSignup.setAttribute('aria-selected', 'false'); }
            if (formLogin) formLogin.classList.remove('hidden');
            if (formSignup) formSignup.classList.add('hidden');
            if (googleAuthBtnText) googleAuthBtnText.textContent = 'התחבר באמצעות Google / Gmail';
            if (authDividerText) authDividerText.textContent = 'או באמצעות כתובת אימייל';
        }
    }

    openGoogleAuthModal() {
        const modal = document.getElementById('google-auth-modal');
        const title = document.getElementById('googleModalTitle');
        if (title) {
            title.textContent = (this.currentAuthMode === 'signup') ? 'הרשמה באמצעות Google' : 'כניסה באמצעות Google';
        }
        if (modal) modal.classList.remove('hidden');
    }

    closeGoogleAuthModal() {
        const modal = document.getElementById('google-auth-modal');
        if (modal) modal.classList.add('hidden');
        const customBox = document.getElementById('customGoogleInputBox');
        if (customBox) customBox.classList.add('hidden');
    }

    toggleCustomGoogleInput() {
        const customBox = document.getElementById('customGoogleInputBox');
        if (customBox) {
            customBox.classList.toggle('hidden');
            if (!customBox.classList.contains('hidden')) {
                const input = document.getElementById('customGoogleEmail');
                if (input) input.focus();
            }
        }
    }

    submitCustomGoogleAccount() {
        const input = document.getElementById('customGoogleEmail');
        const email = input ? input.value.trim().toLowerCase() : '';
        if (!email || !email.includes('@')) {
            this.showAlert("אנא הזן כתובת Google / Gmail חוקית", "error");
            return;
        }

        const username = email.split('@')[0];
        const formattedName = username.charAt(0).toUpperCase() + username.slice(1);
        this.selectGoogleAccount(email, formattedName, 'משתמש Google');
    }

    selectGoogleAccount(email, name, roleLabel) {
        this.closeGoogleAuthModal();

        // החלפת טורניר אם נבחר
        const tourneySelect = (this.currentAuthMode === 'signup') 
            ? document.getElementById('signupTournamentSelect') 
            : document.getElementById('loginTournamentSelect');
        if (tourneySelect && tourneySelect.value) {
            this.switchTournament(tourneySelect.value, false);
        }

        this.showAlert(`מתחבר באמצעות חשבון Google (${email})...`, "info");
        setTimeout(() => {
            this.authenticateUser(email, true, name, 'google');
        }, 300);
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

        // שמירת משתמש רשום ב-localStorage
        const users = this.getRegisteredUsers();
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
            registeredAt: new Date().toLocaleDateString('he-IL'),
            provider: 'email'
        });
        localStorage.setItem('tournament_registered_users', JSON.stringify(users));

        const tourneySelect = document.getElementById('signupTournamentSelect');
        if (tourneySelect && tourneySelect.value) {
            this.switchTournament(tourneySelect.value, false);
        }

        this.authenticateUser(email, true, name, 'email');
    }

    getRegisteredUsers() {
        try {
            const raw = localStorage.getItem('tournament_registered_users');
            return raw ? JSON.parse(raw) : [];
        } catch {
            return [];
        }
    }

    handleLogin() {
        const emailInput = document.getElementById('loginEmail');
        const enteredEmail = emailInput ? emailInput.value.trim().toLowerCase() : '';

        // קבלת הטורניר שנבחר בלוגין
        const tourneySelect = document.getElementById('loginTournamentSelect');
        if (tourneySelect && tourneySelect.value) {
            this.switchTournament(tourneySelect.value, false);
        }

        // חיפוש שם המשתמש אם נרשם בעבר
        let displayName = null;
        if (enteredEmail === this.OWNER_EMAIL.toLowerCase()) {
            displayName = 'נועם סלע';
        } else {
            const registeredUsers = this.getRegisteredUsers();
            const found = registeredUsers.find(u => u.email.toLowerCase() === enteredEmail);
            if (found) displayName = found.name;
        }

        this.authenticateUser(enteredEmail || this.OWNER_EMAIL, true, displayName, 'email');
    }

    loginAsGuest() {
        // קבלת הטורניר שנבחר בלוגין
        const tourneySelect = document.getElementById('loginTournamentSelect');
        if (tourneySelect && tourneySelect.value) {
            this.switchTournament(tourneySelect.value, false);
        }

        this.authenticateUser('guest@tournament.local', true, 'אורח', 'guest');
    }

    authenticateUser(email, showNotification = true, displayName = null, provider = 'email') {
        const cleanEmail = (email || this.OWNER_EMAIL).trim().toLowerCase();
        let role = 'viewer';
        let displayLabel = '';

        if (cleanEmail === this.OWNER_EMAIL.toLowerCase()) {
            role = 'owner';
            displayLabel = displayName ? `👑 בעלים (${displayName})` : `👑 בעלים (${this.OWNER_EMAIL})`;
        } else if (this.adminsList.some(a => a.email.toLowerCase() === cleanEmail)) {
            role = 'admin';
            displayLabel = displayName ? `⚡ מנהל (${displayName})` : `⚡ מנהל (${cleanEmail})`;
        } else if (provider === 'guest' || cleanEmail.includes('guest')) {
            role = 'viewer';
            displayLabel = '👁️ אורח (Guest)';
        } else {
            role = 'viewer';
            displayLabel = displayName ? `👁️ ${displayName}` : `👁️ ${cleanEmail}`;
        }

        this.currentUser = { email: cleanEmail, role, displayName: displayLabel, provider };
        sessionStorage.setItem('tournament_current_user', JSON.stringify(this.currentUser));

        this.switchRole(role);
        this.updateUserSessionUI();
        this.showMainScreen();

        this.renderAdminManagement();
        this.renderOwnerTournamentsList();

        if (showNotification) {
            const providerText = (provider === 'google') ? 'באמצעות Google / Gmail' : '';
            if (role === 'owner') {
                this.showAlert(`ברוך הבא! נכנסת כמנהל על (Owner - ${cleanEmail}) ${providerText} עם גישה מלאה.`, "success");
            } else if (role === 'admin') {
                this.showAlert(`שלום! נכנסת כמנהל מורשה (Admin - ${cleanEmail}) ${providerText}.`, "success");
            } else {
                this.showAlert(`שלום ${displayName || cleanEmail}! נכנסת למערכת הטורניר ${providerText}.`, "info");
            }
        }
    }

    logout() {
        this.currentUser = null;
        sessionStorage.removeItem('tournament_current_user');
        this.showLoginScreen();
        const emailInput = document.getElementById('loginEmail');
        if (emailInput) {
            emailInput.value = 'noamsee@gmail.com';
            emailInput.disabled = false;
        }
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
    }

    switchRole(newRole) {
        this.currentRole = newRole;
        document.body.className = `role-${newRole}`;
        console.log(`[Persona System] Role switched to: ${newRole}`);

        // בדיקה האם הטורניר הנוכחי הוא בארכיון
        const currentTourney = this.tournaments.find(t => t.id === this.activeTournamentId);
        const isArchived = currentTourney && currentTourney.isArchived;

        const isViewer = (newRole === 'viewer') || (isArchived && newRole !== 'owner');

        // חסימת קלט פיזית רק בתוך #screen-main ל-Viewer (לעולם לא בדף הלוגין)
        const allInputs = document.querySelectorAll('#screen-main input:not(#newAdminEmailInput):not(#newTournamentNameInput)');
        allInputs.forEach(input => {
            input.disabled = isViewer;
        });

        // כפתורים המיועדים לעריכה בלבד
        const adminButtons = document.querySelectorAll('.admin-editable');
        adminButtons.forEach(btn => {
            btn.disabled = isViewer;
        });

        // וידוא מוחלט ששדות הלוגין תמיד פעילים
        const loginEmail = document.getElementById('loginEmail');
        if (loginEmail) {
            loginEmail.disabled = false;
            loginEmail.readOnly = false;
        }
    }

    /* ========================================================
       ניהול מנהלים ע"י ה-Owner (Admins Management)
       ======================================================== */

    loadAdmins() {
        const stored = localStorage.getItem('tournament_manager_admins');
        if (stored) {
            try { return JSON.parse(stored); } catch { return []; }
        }
        // ברירת מחדל ראשונית להדגמה
        return [
            { email: 'admin@tournament.com', addedAt: new Date().toLocaleDateString('he-IL') }
        ];
    }

    saveAdmins() {
        localStorage.setItem('tournament_manager_admins', JSON.stringify(this.adminsList));
    }

    addAdmin() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי להוסיף מנהלים!", "error");
            return;
        }

        const input = document.getElementById('newAdminEmailInput');
        if (!input) return;
        const email = input.value.trim().toLowerCase();

        if (!email || !email.includes('@')) {
            this.showAlert("אנא הזן כתובת אימייל חוקית.", "error");
            return;
        }

        if (email === this.OWNER_EMAIL.toLowerCase()) {
            this.showAlert("כתובת זו שייכת כבר ל-Owner של המערכת.", "warning");
            return;
        }

        if (this.adminsList.some(a => a.email.toLowerCase() === email)) {
            this.showAlert("מנהל עם אימייל זה כבר מוגדר במערכת!", "warning");
            return;
        }

        this.adminsList.push({
            email,
            addedAt: new Date().toLocaleDateString('he-IL')
        });

        this.saveAdmins();
        this.renderAdminManagement();
        input.value = '';
        this.showAlert(`מנהל חדש (${email}) נוסף בהצלחה למערכת! כעת הוא יוכל להתחבר כמנהל.`, "success");
    }

    removeAdmin(emailToRemove) {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי להסיר מנהלים!", "error");
            return;
        }

        this.adminsList = this.adminsList.filter(a => a.email.toLowerCase() !== emailToRemove.toLowerCase());
        this.saveAdmins();
        this.renderAdminManagement();
        this.showAlert(`הרשאת המנהל עבור ${emailToRemove} הוסרה.`, "warning");
    }

    renderAdminManagement() {
        const tbody = document.getElementById('adminsListTableBody');
        if (!tbody) return;

        if (this.adminsList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:#64748b; padding:16px;">טרם הוגדרו מנהלים נוספים.</td></tr>`;
            return;
        }

        tbody.innerHTML = this.adminsList.map(a => `
            <tr>
                <td style="font-weight:700; direction:ltr; text-align:right;">${a.email}</td>
                <td><span style="background:#dbeafe; color:#1e40af; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:700;">מנהל מורשה (Admin)</span></td>
                <td style="color:#64748b; font-size:0.85rem;">${a.addedAt}</td>
                <td style="text-align:center;">
                    <button class="btn-delete-admin" onclick="app.removeAdmin('${a.email}')">הסר הרשאה</button>
                </td>
            </tr>
        `).join('');
    }

    /* ========================================================
       ניהול טורנירים וארכיון תוצאות עבר (Multi-Tournament System)
       ======================================================== */

    loadTournaments() {
        const stored = localStorage.getItem('tournament_manager_tournaments_list');
        if (stored) {
            try { return JSON.parse(stored); } catch {}
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

    saveTournamentsList() {
        localStorage.setItem('tournament_manager_tournaments_list', JSON.stringify(this.tournaments));
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
    }

    loadTournamentData(tourneyId) {
        let tData = this.tournaments.find(t => t.id === tourneyId);
        if (!tData) {
            tData = this.tournaments[0];
            this.activeTournamentId = tData.id;
        }

        this.teams = tData.teams ? [...tData.teams] : [...this.defaultTeams];

        if (tData.matches && tData.matches.length > 0) {
            this.groups = tData.groups;
            this.matches = tData.matches;
            this.standings = tData.standings;
            this.playoffSeeds = tData.playoffSeeds || [];
            this.playoffMatches = tData.playoffMatches || { qf: [], sf: [], final: null };
            this.renderTeamInputs();
            this.renderMatches();
            this.renderStandings();
            if (this.playoffSeeds.length === 8) {
                this.renderPlayoffBracket();
            }
        } else {
            this.renderTeamInputs();
            this.generateTournamentGroups(false);
        }

        // עדכון באנר הארכיון
        const archiveBanner = document.getElementById('archiveBanner');
        if (archiveBanner) {
            if (tData.isArchived) {
                archiveBanner.classList.remove('hidden');
            } else {
                archiveBanner.classList.add('hidden');
            }
        }

        // סנכרון תפריטים
        this.populateTournamentSelectors();
        this.switchRole(this.currentRole);
    }

    saveActiveTournamentData() {
        const idx = this.tournaments.findIndex(t => t.id === this.activeTournamentId);
        if (idx !== -1) {
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

        // שמירת הטורניר הקודם אם הוא פעיל
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
        }
    }

    createNewTournament() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לפתוח טורניר חדש!", "error");
            return;
        }

        const input = document.getElementById('newTournamentNameInput');
        const name = input ? input.value.trim() : '';
        const tourneyName = name || `טורניר חדש ${new Date().toLocaleDateString('he-IL')}`;

        const newId = `tourney_${Date.now()}`;
        const newTournament = {
            id: newId,
            name: tourneyName,
            createdAt: new Date().toLocaleDateString('he-IL'),
            isArchived: false,
            teams: [...this.defaultTeams]
        };

        this.saveActiveTournamentData();
        this.tournaments.unshift(newTournament);
        this.saveTournamentsList();

        this.activeTournamentId = newId;
        this.loadTournamentData(newId);
        this.renderOwnerTournamentsList();
        if (input) input.value = '';

        this.showAlert(`הטורניר '${tourneyName}' נוצר בהצלחה והוגדר כטורניר פעיל!`, "success");
    }

    archiveCurrentTournament() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לארכב טורניר!", "error");
            return;
        }

        const curr = this.tournaments.find(t => t.id === this.activeTournamentId);
        if (!curr) return;

        curr.isArchived = true;
        curr.name = curr.name.replace(' (פעיל)', '') + ' (ארכיון)';
        this.saveActiveTournamentData();
        this.populateTournamentSelectors();
        this.renderOwnerTournamentsList();
        this.loadTournamentData(curr.id);

        this.showAlert(`הטורניר הועבר בהצלחה לארכיון תוצאות עבר.`, "success");
    }

    renderOwnerTournamentsList() {
        const container = document.getElementById('ownerTournamentsList');
        if (!container) return;

        container.innerHTML = `
            <table class="admins-table">
                <thead>
                    <tr>
                        <th>שם הטורניר</th>
                        <th>סטטוס</th>
                        <th>תאריך פתיחה</th>
                        <th style="width: 140px; text-align: center;">מעבר / בחירה</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.tournaments.map(t => `
                        <tr style="${t.id === this.activeTournamentId ? 'background:#f0fdf4;' : ''}">
                            <td style="font-weight:700;">${t.name}</td>
                            <td>
                                <span style="background:${t.isArchived ? '#fef3c7' : '#dcfce7'}; color:${t.isArchived ? '#92400e' : '#15803d'}; padding:3px 8px; border-radius:12px; font-size:0.8rem; font-weight:700;">
                                    ${t.isArchived ? 'ארכיון עבר' : 'טורניר פעיל'}
                                </span>
                            </td>
                            <td style="color:#64748b; font-size:0.85rem;">${t.createdAt || '-'}</td>
                            <td style="text-align:center;">
                                <button class="btn-secondary btn-sm" onclick="app.switchTournament('${t.id}')">
                                    ${t.id === this.activeTournamentId ? '✅ פעיל כעת' : 'צפה בטורניר'}
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    /* ========================================================
       התראות, ניווט בטאבים והזנת שמות קבוצות
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
        document.querySelectorAll('.tab-section').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

        const targetSection = document.getElementById(`tab-${tabId}`);
        if (targetSection) targetSection.classList.remove('hidden');

        const targetBtn = Array.from(document.querySelectorAll('.tab-btn')).find(btn => 
            btn.getAttribute('onclick')?.includes(`'${tabId}'`)
        );
        if (targetBtn) targetBtn.classList.add('active');
    }

    renderTeamInputs() {
        const container = document.getElementById('teams-input-container');
        if (!container) return;
        
        container.innerHTML = '';
        this.teams.forEach((teamName, index) => {
            const groupIndex = Math.floor(index / 5);
            const groupLetter = String.fromCharCode(65 + groupIndex);
            const groupHe = groupLetter === 'A' ? "א'" : groupLetter === 'B' ? "ב'" : "ג'";

            const div = document.createElement('div');
            div.className = 'team-input-group';
            div.innerHTML = `
                <label>בית ${groupHe} - קבוצה ${(index % 5) + 1}</label>
                <input type="text" value="${teamName}" data-index="${index}" 
                       onchange="app.updateTeamName(${index}, this.value)"
                       placeholder="הזן שם קבוצה">
            `;
            container.appendChild(div);
        });
    }

    updateTeamName(index, newName) {
        const trimmed = newName.trim();
        this.teams[index] = trimmed || `קבוצה ${index + 1}`;
        this.syncTeamNamesToMatches();
        this.saveActiveTournamentData();
    }

    fillDefaultTeamNames() {
        this.teams = [...this.defaultTeams];
        this.renderTeamInputs();
        this.syncTeamNamesToMatches();
        this.saveActiveTournamentData();
        this.showAlert("שמות הקבוצות שוחזרו לברירת המחדל.", "success");
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
       אלגוריתם 1: Round-Robin של 30 משחקים (3 בתים של 5)
       ======================================================== */

    generateTournamentGroups(shouldSwitchTab = true) {
        this.groups = {
            'Group A': this.teams.slice(0, 5).map((name, i) => ({ index: i, name, group: 'Group A' })),
            'Group B': this.teams.slice(5, 10).map((name, i) => ({ index: i + 5, name, group: 'Group B' })),
            'Group C': this.teams.slice(10, 15).map((name, i) => ({ index: i + 10, name, group: 'Group C' }))
        };

        const roundRobinTemplate = [
            [ { home: 0, away: 4 }, { home: 1, away: 3 } ],
            [ { home: 4, away: 3 }, { home: 0, away: 2 } ],
            [ { home: 1, away: 4 }, { home: 2, away: 3 } ],
            [ { home: 4, away: 2 }, { home: 0, away: 1 } ],
            [ { home: 3, away: 0 }, { home: 1, away: 2 } ]
        ];

        this.matches = [];
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

                    this.matches.push({
                        id: `match_${matchCounter}`,
                        matchNumber: matchCounter,
                        groupId: grp.key,
                        groupNameHe: grp.nameHe,
                        round: roundNum,
                        team1Index: t1Idx,
                        team2Index: t2Idx,
                        team1Name: this.teams[t1Idx],
                        team2Name: this.teams[t2Idx],
                        score1: null,
                        score2: null,
                        winner: null
                    });
                    matchCounter++;
                });
            });
        });

        this.renderMatches();
        this.calculateStandings();
        this.saveActiveTournamentData();

        const seedBtn = document.getElementById('btn-seed-playoffs');
        if (seedBtn) seedBtn.classList.remove('hidden');

        if (shouldSwitchTab) {
            this.switchTab('group-stage');
            this.showAlert("לוח המשחקים נוצר בהצלחה! 30 משחקים חולקו ל-3 בתים.", "success");
        }
    }

    renderMatches() {
        const container = document.getElementById('group-matches-container');
        if (!container) return;

        const filteredMatches = this.currentFilter === 'all'
            ? this.matches
            : this.matches.filter(m => m.groupId === this.currentFilter);

        if (filteredMatches.length === 0) {
            container.innerHTML = '<p class="placeholder-text">אין משחקים להצגה.</p>';
            return;
        }

        const isViewer = (this.currentRole === 'viewer') || (this.tournaments.find(t => t.id === this.activeTournamentId)?.isArchived && this.currentRole !== 'owner');

        container.innerHTML = `
            <div class="matches-grid">
                ${filteredMatches.map(m => {
                    const row1WinnerClass = m.winner === 'team1' ? 'winner' : '';
                    const row2WinnerClass = m.winner === 'team2' ? 'winner' : '';
                    const score1Val = m.score1 !== null ? m.score1 : '';
                    const score2Val = m.score2 !== null ? m.score2 : '';

                    return `
                        <div class="match-card" id="card-${m.id}" data-match-id="${m.id}">
                            <div class="match-header">
                                <span>${m.groupNameHe} • מחזור ${m.round}</span>
                                <span class="match-badge">משחק #${m.matchNumber}</span>
                            </div>
                            
                            <div class="match-team-row ${row1WinnerClass}" id="row-${m.id}-1">
                                <span class="team-name" title="${m.team1Name}">${m.team1Name}</span>
                                <input type="number" min="0" step="1" 
                                       class="score-input" 
                                       value="${score1Val}" 
                                       placeholder="-"
                                       ${isViewer ? 'disabled' : ''}
                                       oninput="app.handleScoreChange('${m.id}', 1, this.value, this)">
                            </div>

                            <div class="match-team-row ${row2WinnerClass}" id="row-${m.id}-2">
                                <span class="team-name" title="${m.team2Name}">${m.team2Name}</span>
                                <input type="number" min="0" step="1" 
                                       class="score-input" 
                                       value="${score2Val}" 
                                       placeholder="-"
                                       ${isViewer ? 'disabled' : ''}
                                       oninput="app.handleScoreChange('${m.id}', 2, this.value, this)">
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    filterMatches(groupKey, buttonEl) {
        this.currentFilter = groupKey;
        document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.remove('active'));
        if (buttonEl) buttonEl.classList.add('active');
        this.renderMatches();
    }

    /* ========================================================
       אלגוריתם 2: אימות תוצאות ואיסור תיקו מוחלט (No-Ties Rule)
       ======================================================== */

    handleScoreChange(matchId, teamNum, rawValue, inputElement) {
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

        // בדיקת תיקו קפדנית
        if (match.score1 !== null && match.score2 !== null) {
            if (match.score1 === match.score2) {
                this.showAlert("⚠️ חוק הטורניר: חל איסור מוחלט על תוצאת תיקו! יש להכריע את המשחק.", "error");
                inputElement.value = '';
                if (teamNum === 1) match.score1 = null;
                else match.score2 = null;
                match.winner = null;
                this.updateMatchRowWinners(match);
                this.calculateStandings();
                return;
            }
            match.winner = (match.score1 > match.score2) ? 'team1' : 'team2';
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
            row1.classList.remove('winner');
            row2.classList.remove('winner');
            if (match.winner === 'team1') row1.classList.add('winner');
            else if (match.winner === 'team2') row2.classList.add('winner');
        }
    }

    /* ========================================================
       אלגוריתם 3: טבלאות דירוג דינמיות (מיון לפי נצחונות והפרש)
       ======================================================== */

    calculateStandings() {
        const groupKeys = ['Group A', 'Group B', 'Group C'];
        const groupHeaders = {
            'Group A': "בית א'",
            'Group B': "בית ב'",
            'Group C': "בית ג'"
        };

        const calculatedStandings = {};

        groupKeys.forEach(grpKey => {
            const teamsInGroup = this.groups[grpKey] || [];
            const stats = teamsInGroup.map(t => ({
                teamIndex: t.index,
                teamName: this.teams[t.index],
                group: grpKey,
                played: 0,
                wins: 0,
                losses: 0,
                pointsFor: 0,
                pointsAgainst: 0,
                pointDiff: 0
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
                        if (m.winner === 'team1') { t1.wins++; t2.losses++; }
                        else if (m.winner === 'team2') { t2.wins++; t1.losses++; }
                    }
                }
            });

            stats.forEach(s => { s.pointDiff = s.pointsFor - s.pointsAgainst; });

            // מיון: 1. ניצחונות -> 2. הפרש נקודות -> 3. נקודות זכות
            stats.sort((a, b) => {
                if (b.wins !== a.wins) return b.wins - a.wins;
                if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
                if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
                return a.teamName.localeCompare(b.teamName);
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

        const headers = groupHeaders || { 'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'" };
        let html = '';

        for (const [grpKey, teams] of Object.entries(this.standings)) {
            const grpMatches = this.matches.filter(m => m.groupId === grpKey);
            const grpPlayed = grpMatches.filter(m => m.score1 !== null && m.score2 !== null).length;

            html += `
                <div class="standings-group-card">
                    <div class="standings-group-header">
                        <span>${headers[grpKey]}</span>
                        <span style="font-size:0.8rem; font-weight:normal; opacity:0.9;">שוחקו: ${grpPlayed}/10 משחקים</span>
                    </div>
                    <div class="standings-table-wrap">
                        <table class="standings-table">
                            <thead>
                                <tr>
                                    <th style="width: 34px;">מיקום</th>
                                    <th style="text-align: right; padding-right: 10px;">קבוצה</th>
                                    <th>מש'</th>
                                    <th>ניצחונות</th>
                                    <th>הפסדים</th>
                                    <th>זכות</th>
                                    <th>חובה</th>
                                    <th>הפרש</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${teams.map(t => {
                                    let rowClass = '';
                                    let rankClass = 'rank-out';
                                    if (t.groupRank <= 2) {
                                        rowClass = 'row-direct-qualify';
                                        rankClass = 'rank-top';
                                    } else if (t.groupRank === 3) {
                                        rowClass = 'row-candidate-qualify';
                                        rankClass = 'rank-third';
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
                                            <td><span class="rank-indicator ${rankClass}">${t.groupRank}</span></td>
                                            <td class="team-cell" title="${t.teamName}">${t.teamName}</td>
                                            <td>${t.played}</td>
                                            <td style="color:#16a34a; font-weight:800;">${t.wins}</td>
                                            <td style="color:#dc2626;">${t.losses}</td>
                                            <td>${t.pointsFor}</td>
                                            <td>${t.pointsAgainst}</td>
                                            <td class="${diffClass}">${diffStr}</td>
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

    /* ========================================================
       אלגוריתם 4: שיבוץ פלייאוף 8 הגדולות ועץ הנוקאאוט
       ======================================================== */

    seedPlayoffs() {
        this.calculateStandings();

        const standingsA = this.standings['Group A'];
        const standingsB = this.standings['Group B'];
        const standingsC = this.standings['Group C'];

        if (!standingsA || !standingsB || !standingsC) {
            this.showAlert("שגיאה בנתוני הבתים. יש לייצר לוח משחקים תחילה.", "error");
            return;
        }

        const playedCount = this.matches.filter(m => m.score1 !== null && m.score2 !== null).length;
        if (playedCount < 30) {
            this.showAlert(`שים לב: שוחקו ${playedCount} מתוך 30 משחקי בתים. הפלייאוף משובץ לפי הטבלה הנוכחית.`, "warning");
        }

        const firstPlaces = [
            { ...standingsA[0], origin: "מקום 1 בית א'" },
            { ...standingsB[0], origin: "מקום 1 בית ב'" },
            { ...standingsC[0], origin: "מקום 1 בית ג'" }
        ];

        const secondPlaces = [
            { ...standingsA[1], origin: "מקום 2 בית א'" },
            { ...standingsB[1], origin: "מקום 2 בית ב'" },
            { ...standingsC[1], origin: "מקום 2 בית ג'" }
        ];

        const thirdPlaces = [
            { ...standingsA[2], origin: "מקום 3 בית א'" },
            { ...standingsB[2], origin: "מקום 3 בית ב'" },
            { ...standingsC[2], origin: "מקום 3 בית ג'" }
        ];

        const sortPerformance = (a, b) => {
            if (b.wins !== a.wins) return b.wins - a.wins;
            if (b.pointDiff !== a.pointDiff) return b.pointDiff - a.pointDiff;
            if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
            return a.teamName.localeCompare(b.teamName);
        };

        firstPlaces.sort(sortPerformance);
        secondPlaces.sort(sortPerformance);
        thirdPlaces.sort(sortPerformance);

        const bestTwoThirds = [thirdPlaces[0], thirdPlaces[1]];
        const eliminatedThird = thirdPlaces[2];

        this.playoffSeeds = [
            { seed: 1, ...firstPlaces[0] },
            { seed: 2, ...firstPlaces[1] },
            { seed: 3, ...firstPlaces[2] },
            { seed: 4, ...secondPlaces[0] },
            { seed: 5, ...secondPlaces[1] },
            { seed: 6, ...secondPlaces[2] },
            { seed: 7, ...bestTwoThirds[0] },
            { seed: 8, ...bestTwoThirds[1] }
        ];

        this.playoffMatches = {
            qf: [
                {
                    id: 'qf_1', roundName: 'רבע גמר 1',
                    seed1: 1, seed2: 8,
                    team1: this.playoffSeeds[0], team2: this.playoffSeeds[7],
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_1', nextSlot: 1
                },
                {
                    id: 'qf_2', roundName: 'רבע גמר 2',
                    seed1: 4, seed2: 5,
                    team1: this.playoffSeeds[3], team2: this.playoffSeeds[4],
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_1', nextSlot: 2
                },
                {
                    id: 'qf_3', roundName: 'רבע גמר 3',
                    seed1: 3, seed2: 6,
                    team1: this.playoffSeeds[2], team2: this.playoffSeeds[5],
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_2', nextSlot: 1
                },
                {
                    id: 'qf_4', roundName: 'רבע גמר 4',
                    seed1: 2, seed2: 7,
                    team1: this.playoffSeeds[1], team2: this.playoffSeeds[6],
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'sf_2', nextSlot: 2
                }
            ],
            sf: [
                {
                    id: 'sf_1', roundName: 'חצי גמר 1 (מנצחת 1v8 נגד 4v5)',
                    team1: null, team2: null,
                    score1: null, score2: null, winner: null,
                    nextMatchId: 'final', nextSlot: 1
                },
                {
                    id: 'sf_2', roundName: 'חצי גמר 2 (מנצחת 3v6 נגד 2v7)',
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

        this.renderPlayoffBracket(eliminatedThird);
        this.saveActiveTournamentData();
        this.switchTab('playoffs');
        this.showAlert("שלב הבתים ננעל בהצלחה! 8 הקבוצות שובצו לעץ הנוקאאוט.", "success");
    }

    renderPlayoffBracket(eliminatedThird = null) {
        const container = document.getElementById('playoff-bracket-container');
        if (!container) return;

        const isViewer = (this.currentRole === 'viewer') || (this.tournaments.find(t => t.id === this.activeTournamentId)?.isArchived && this.currentRole !== 'owner');

        const seedsSummaryHtml = `
            <div class="seed-summary-card">
                <div style="font-weight: 800; font-size: 1.05rem; margin-bottom: 6px; color:#0f172a;">
                    🎯 8 הקבוצות המעפילות לפלייאוף:
                </div>
                <div style="font-size: 0.85rem; color: #64748b; margin-bottom: 10px;">
                    עלו 2 הראשונות מכל בית + 2 קבוצות מקום 3 הטובות ביותר
                    ${eliminatedThird ? `(הודחה: <strong>${eliminatedThird.teamName}</strong> שסיימה כמקום 3 עם המאזן הנמוך)` : ''}
                </div>
                <div class="seed-grid">
                    ${this.playoffSeeds.map(s => `
                        <div class="seed-chip">
                            <span style="font-weight: 700; color: #1e293b;">
                                <span class="seed-badge">${s.seed}</span> ${s.teamName}
                            </span>
                            <span style="font-size: 0.78rem; color: #64748b;">
                                ${s.wins} נצ' | הפרש ${s.pointDiff > 0 ? '+' : ''}${s.pointDiff}
                            </span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        const qf = this.playoffMatches.qf;
        const sf = this.playoffMatches.sf;
        const final = this.playoffMatches.final;

        const renderPlayoffCard = (m, isFinal = false) => {
            const team1Name = m.team1 ? m.team1.teamName : 'ממתין לתוצאה...';
            const team2Name = m.team2 ? m.team2.teamName : 'ממתין לתוצאה...';
            const team1Seed = m.team1 ? `(#${m.team1.seed})` : '';
            const team2Seed = m.team2 ? `(#${m.team2.seed})` : '';

            const row1Winner = m.winner === 'team1' ? 'winner' : '';
            const row2Winner = m.winner === 'team2' ? 'winner' : '';

            const score1Val = m.score1 !== null ? m.score1 : '';
            const score2Val = m.score2 !== null ? m.score2 : '';
            const disabledInputs = isViewer || !m.team1 || !m.team2;

            return `
                <div class="match-card playoff-match-card ${isFinal ? 'is-final' : ''}" id="playoff-card-${m.id}">
                    <div class="match-header" style="${isFinal ? 'background: #b45309;' : ''}">
                        <span>${m.roundName}</span>
                    </div>

                    <div class="match-team-row ${row1Winner}" id="prow-${m.id}-1">
                        <span class="team-name" title="${team1Name}">
                            ${team1Name} <small style="font-weight:normal; opacity:0.8;">${team1Seed}</small>
                        </span>
                        <input type="number" min="0" step="1" 
                               class="score-input" 
                               value="${score1Val}" 
                               placeholder="-"
                               ${disabledInputs ? 'disabled' : ''}
                               oninput="app.handlePlayoffScore('${m.id}', 1, this.value, this)">
                    </div>

                    <div class="match-team-row ${row2Winner}" id="prow-${m.id}-2">
                        <span class="team-name" title="${team2Name}">
                            ${team2Name} <small style="font-weight:normal; opacity:0.8;">${team2Seed}</small>
                        </span>
                        <input type="number" min="0" step="1" 
                               class="score-input" 
                               value="${score2Val}" 
                               placeholder="-"
                               ${disabledInputs ? 'disabled' : ''}
                               oninput="app.handlePlayoffScore('${m.id}', 2, this.value, this)">
                    </div>
                </div>
            `;
        };

        let championBannerHtml = '';
        if (final && final.winner) {
            const championTeam = final.winner === 'team1' ? final.team1 : final.team2;
            championBannerHtml = `
                <div class="champion-banner">
                    <h3>🏆 אלופת הטורניר! 🏆</h3>
                    <div class="champ-name">${championTeam.teamName}</div>
                    <p style="margin: 0; color: #92400e; font-weight: 700;">
                        כל הכבוד לאלופה הגדולה על ניצחון מוחץ בטורניר הדו-שלבי!
                    </p>
                </div>
            `;
        }

        container.innerHTML = `
            ${seedsSummaryHtml}

            <div class="bracket-rounds-container">
                <div class="bracket-round-column">
                    <div class="round-header">⚔️ רבע גמר</div>
                    ${qf.map(m => renderPlayoffCard(m)).join('')}
                </div>

                <div class="bracket-round-column">
                    <div class="round-header">🔥 חצי גמר</div>
                    ${sf.map(m => renderPlayoffCard(m)).join('')}
                </div>

                <div class="bracket-round-column">
                    <div class="round-header" style="background:#b45309;">👑 משחק הגמר</div>
                    ${renderPlayoffCard(final, true)}
                </div>
            </div>

            ${championBannerHtml}
        `;
    }

    handlePlayoffScore(matchId, teamNum, rawValue, inputElement) {
        let match = null;

        if (matchId.startsWith('qf')) match = this.playoffMatches.qf.find(m => m.id === matchId);
        else if (matchId.startsWith('sf')) match = this.playoffMatches.sf.find(m => m.id === matchId);
        else if (matchId === 'final') match = this.playoffMatches.final;

        if (!match) return;

        if (rawValue === '' || rawValue === null || rawValue === undefined) {
            if (teamNum === 1) match.score1 = null;
            if (teamNum === 2) match.score2 = null;
            match.winner = null;
            this.propagatePlayoffWinner(match, null);
            this.renderPlayoffBracket();
            this.saveActiveTournamentData();
            return;
        }

        const parsed = Number(rawValue);
        if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
            this.showAlert("שגיאת תוצאה: יש להזין מספר שלם וחיובי בלבד.", "error");
            inputElement.value = '';
            if (teamNum === 1) match.score1 = null;
            else match.score2 = null;
            match.winner = null;
            this.propagatePlayoffWinner(match, null);
            this.renderPlayoffBracket();
            return;
        }

        if (teamNum === 1) match.score1 = parsed;
        else match.score2 = parsed;

        if (match.score1 !== null && match.score2 !== null) {
            if (match.score1 === match.score2) {
                this.showAlert("⚠️ חוק הטורניר: חל איסור מוחלט על תוצאת תיקו בפלייאוף! יש להכריע את המשחק.", "error");
                inputElement.value = '';
                if (teamNum === 1) match.score1 = null;
                else match.score2 = null;
                match.winner = null;
                this.propagatePlayoffWinner(match, null);
                this.renderPlayoffBracket();
                return;
            }

            match.winner = match.score1 > match.score2 ? 'team1' : 'team2';
            const winnerTeam = match.winner === 'team1' ? match.team1 : match.team2;
            this.propagatePlayoffWinner(match, winnerTeam);
        } else {
            match.winner = null;
            this.propagatePlayoffWinner(match, null);
        }

        this.renderPlayoffBracket();
        this.saveActiveTournamentData();
    }

    propagatePlayoffWinner(match, winnerTeam) {
        if (!match.nextMatchId) return;

        let nextMatch = null;
        if (match.nextMatchId.startsWith('sf')) {
            nextMatch = this.playoffMatches.sf.find(m => m.id === match.nextMatchId);
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
        this.matches.forEach(m => {
            let s1 = 60 + Math.floor(Math.random() * 40);
            let s2 = 60 + Math.floor(Math.random() * 40);
            if (s1 === s2) s1 += 2;
            m.score1 = s1;
            m.score2 = s2;
            m.winner = s1 > s2 ? 'team1' : 'team2';
        });

        this.renderMatches();
        this.calculateStandings();
        this.saveActiveTournamentData();
        this.showAlert("הוזנו תוצאות לדוגמה לכל 30 המשחקים ללא תוצאות תיקו!", "success");
    }

    resetAllScores() {
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
        if (!this.playoffSeeds || this.playoffSeeds.length < 8) {
            this.showAlert("יש לנעול את שלב הבתים ולשבץ פלייאוף תחילה.", "error");
            return;
        }

        this.playoffMatches.qf.forEach(m => {
            const s1 = 70 + Math.floor(Math.random() * 30);
            let s2 = 70 + Math.floor(Math.random() * 30);
            if (s1 === s2) s2 += 3;
            m.score1 = s1; m.score2 = s2;
            m.winner = s1 > s2 ? 'team1' : 'team2';
            const winnerTeam = m.winner === 'team1' ? m.team1 : m.team2;
            this.propagatePlayoffWinner(m, winnerTeam);
        });

        this.playoffMatches.sf.forEach(m => {
            if (m.team1 && m.team2) {
                const s1 = 75 + Math.floor(Math.random() * 25);
                let s2 = 75 + Math.floor(Math.random() * 25);
                if (s1 === s2) s2 += 2;
                m.score1 = s1; m.score2 = s2;
                m.winner = s1 > s2 ? 'team1' : 'team2';
                const winnerTeam = m.winner === 'team1' ? m.team1 : m.team2;
                this.propagatePlayoffWinner(m, winnerTeam);
            }
        });

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
        if (!this.playoffSeeds || this.playoffSeeds.length === 0) return;
        this.seedPlayoffs();
    }

    hardReset() {
        if (this.currentRole !== 'owner') {
            this.showAlert("רק Owner רשאי לאפס את הטורניר לחלוטין!", "error");
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
        rows.push([escapeCSV("🏆 מנהל טורניר דו-שלבי - נתוני טורניר וטבלאות דירוג")]);
        const currentTourney = this.tournaments.find(t => t.id === this.activeTournamentId);
        rows.push([escapeCSV("שם טורניר"), escapeCSV(currentTourney?.name || "טורניר פעיל")]);
        rows.push([escapeCSV("תאריך הפקה"), escapeCSV(new Date().toLocaleString('he-IL'))]);
        rows.push([]);

        rows.push([escapeCSV("=== טבלאות דירוג שלב הבתים ===")]);
        rows.push([
            escapeCSV("בית"), escapeCSV("מיקום"), escapeCSV("קבוצה"),
            escapeCSV("משחקים שוחקו"), escapeCSV("ניצחונות"), escapeCSV("הפסדים"),
            escapeCSV("נקודות זכות"), escapeCSV("נקודות חובה"), escapeCSV("הפרש נקודות"),
            escapeCSV("סטטוס העפלה")
        ]);

        const groupLabels = { 'Group A': "בית א'", 'Group B': "בית ב'", 'Group C': "בית ג'" };
        for (const [grpKey, grpLabel] of Object.entries(groupLabels)) {
            const stats = this.standings[grpKey] || [];
            stats.forEach(s => {
                let statusText = s.groupRank <= 2 ? "עולה ישירה (Top 2)" : s.groupRank === 3 ? "מועמדת לעלייה (מקום 3)" : "הודחה";
                rows.push([
                    escapeCSV(grpLabel), escapeCSV(s.groupRank), escapeCSV(s.teamName),
                    escapeCSV(s.played), escapeCSV(s.wins), escapeCSV(s.losses),
                    escapeCSV(s.pointsFor), escapeCSV(s.pointsAgainst),
                    escapeCSV(s.pointDiff > 0 ? `+${s.pointDiff}` : s.pointDiff),
                    escapeCSV(statusText)
                ]);
            });
        }
        rows.push([]);

        rows.push([escapeCSV("=== תוצאות ולוח משחקי שלב הבתים (30 משחקים) ===")]);
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
                winnerStr = m.winner === 'team1' ? m.team1Name : m.team2Name;
                statusStr = "הסתיים";
            }
            rows.push([
                escapeCSV(m.matchNumber), escapeCSV(m.groupNameHe), escapeCSV(`מחזור ${m.round}`),
                escapeCSV(m.team1Name), escapeCSV(score1Str), escapeCSV(score2Str),
                escapeCSV(m.team2Name), escapeCSV(winnerStr), escapeCSV(statusStr)
            ]);
        });
        rows.push([]);

        rows.push([escapeCSV("=== שלב הפלייאוף - 8 הגדולות ===")]);
        if (this.playoffSeeds && this.playoffSeeds.length === 8) {
            rows.push([escapeCSV("--- 8 הקבוצות המדורגות ---")]);
            rows.push([escapeCSV("דירוג"), escapeCSV("שם קבוצה"), escapeCSV("מקור העפלה"), escapeCSV("ניצחונות"), escapeCSV("הפרש")]);
            this.playoffSeeds.forEach(s => {
                rows.push([
                    escapeCSV(`דירוג ${s.seed}`), escapeCSV(s.teamName),
                    escapeCSV(s.origin || `מקום בבית`), escapeCSV(s.wins),
                    escapeCSV(s.pointDiff > 0 ? `+${s.pointDiff}` : s.pointDiff)
                ]);
            });
            rows.push([]);

            rows.push([escapeCSV("--- משחקי פלייאוף ותוצאות ---")]);
            rows.push([escapeCSV("שלב"), escapeCSV("משחק"), escapeCSV("קבוצה 1"), escapeCSV("תוצאה 1"), escapeCSV("תוצאה 2"), escapeCSV("קבוצה 2"), escapeCSV("מנצחת / מעפילה")]);

            this.playoffMatches.qf.forEach(qf => {
                const s1 = qf.score1 !== null ? qf.score1 : "";
                const s2 = qf.score2 !== null ? qf.score2 : "";
                const win = qf.winner ? (qf.winner === 'team1' ? qf.team1.teamName : qf.team2.teamName) : "ממתין להכרעה";
                rows.push([escapeCSV("רבע גמר"), escapeCSV(qf.roundName), escapeCSV(`${qf.team1.teamName} (דירוג ${qf.seed1})`), escapeCSV(s1), escapeCSV(s2), escapeCSV(`${qf.team2.teamName} (דירוג ${qf.seed2})`), escapeCSV(win)]);
            });

            this.playoffMatches.sf.forEach(sf => {
                const t1 = sf.team1 ? sf.team1.teamName : "ממתין";
                const t2 = sf.team2 ? sf.team2.teamName : "ממתין";
                const s1 = sf.score1 !== null ? sf.score1 : "";
                const s2 = sf.score2 !== null ? sf.score2 : "";
                const win = sf.winner ? (sf.winner === 'team1' ? sf.team1.teamName : sf.team2.teamName) : "ממתין להכרעה";
                rows.push([escapeCSV("חצי גמר"), escapeCSV(sf.roundName), escapeCSV(t1), escapeCSV(s1), escapeCSV(s2), escapeCSV(t2), escapeCSV(win)]);
            });

            if (this.playoffMatches.final) {
                const fn = this.playoffMatches.final;
                const t1 = fn.team1 ? fn.team1.teamName : "ממתין";
                const t2 = fn.team2 ? fn.team2.teamName : "ממתין";
                const s1 = fn.score1 !== null ? fn.score1 : "";
                const s2 = fn.score2 !== null ? fn.score2 : "";
                const win = fn.winner ? (fn.winner === 'team1' ? fn.team1.teamName : fn.team2.teamName) : "ממתין להכרעה";
                rows.push([escapeCSV("גמר"), escapeCSV(fn.roundName), escapeCSV(t1), escapeCSV(s1), escapeCSV(s2), escapeCSV(t2), escapeCSV(win)]);
                if (fn.winner) {
                    const champ = fn.winner === 'team1' ? fn.team1.teamName : fn.team2.teamName;
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

        let md = `# 🏆 מנהל טורניר דו-שלבי - Two-Stage Tournament Manager\n\n`;
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
