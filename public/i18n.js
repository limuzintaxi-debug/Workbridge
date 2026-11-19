/**
 * Bilingual interface layer (English / Arabic) with RTL support.
 *
 * Every visible string goes through t(); missing keys fall back to English so a
 * partially translated screen never shows a raw key to the user.
 */

const DICT = {
  en: {
    'brand.tagline': 'Booking • Agreement • Institutional & Social Support • Invoice Maker',
    'brand.sub': 'Connecting Workers, Businesses & Support Organizations',
    'brand.actions': 'Find Work • Make Agreements • Create Invoices',
    'nav.dashboard': 'Dashboard',
    'nav.findWork': 'Find Work',
    'nav.applications': 'Applications',
    'nav.agreements': 'Agreements',
    'nav.invoices': 'Invoices',
    'nav.alerts': 'Alerts',
    'nav.profile': 'Profile',
    'nav.listings': 'Listings',
    'nav.postWork': 'Post Work',
    'nav.workers': 'Workers',
    'nav.overview': 'Overview',
    'nav.users': 'Users',
    'nav.institutions': 'Institutions',
    'nav.documents': 'Documents',
    'nav.reports': 'Reports',
    'nav.settings': 'Settings',
    'nav.admin': 'Admin',
    'nav.signOut': 'Sign out',
    'nav.postWorkShort': 'Post Work',
    'nav.help': 'Help',
    'home.worker': 'WORKER',
    'home.business': 'BUSINESS',
    'home.workerCopy': 'Find work, apply to listings, sign agreements and create invoices — all from your phone.',
    'home.businessCopy': 'Post work opportunities, find workers, manage agreements and issue invoices.',
    'home.signUp': 'Sign Up',
    'home.signIn': 'Sign In',
    'home.adminLogin': 'Admin Login',
    'home.support': 'Help & Support',
    'home.supportCopy': 'Questions about your account, listings, agreements or invoices? Email us at',
    'home.institutionTitle': 'Institutional & Social Support',
    'home.institutionCopy':
      'Support organizations can register to be listed. Every registration is reviewed by an administrator before it appears.',
    'home.registerInstitution': 'Register an institution',
    'home.openSupport': 'Open Help & Support',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.fullName': 'Full name',
    'auth.phone': 'Phone number',
    'auth.category': 'Work category / skill',
    'auth.city': 'City / area',
    'auth.aqama': 'Aqama number (optional)',
    'auth.aqamaHint': 'Only the last 4 characters are stored, in masked form.',
    'auth.experience': 'Years of experience',
    'auth.skills': 'Skills (comma separated)',
    'auth.bio': 'Short introduction',
    'auth.company': 'Company name',
    'auth.contact': 'Contact person',
    'auth.country': 'Country',
    'auth.address': 'Address',
    'auth.website': 'Website (optional)',
    'auth.about': 'About the business',
    'auth.createAccount': 'Create account',
    'auth.signIn': 'Sign in',
    'auth.signInTitle': 'Sign in',
    'auth.forgot': 'Forgot your password?',
    'auth.haveAccount': 'Already have an account? Sign in',
    'auth.createWorker': 'Create a worker account',
    'auth.createBusiness': 'Create a business account',
    'auth.signinNote': 'Sign in with the email and password you registered with.',
    'auth.signupNote': 'All fields marked required must be completed.',
    'auth.resetTitle': 'Reset your password',
    'auth.resetSend': 'Send reset link',
    'auth.resetSent': 'If that email is registered, a reset link has been sent.',
    'auth.newPassword': 'New password',
    'auth.confirmPassword': 'Confirm password',
    'auth.setPassword': 'Set new password',
    'auth.currentPassword': 'Current password',
    'auth.changePassword': 'Change password',
    'auth.account': 'Account',
    'auth.pending': 'Your registration was received and is awaiting administrator approval.',
    'auth.adminOnly': 'Admin accounts are created by the platform owner. There is no public admin registration.',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.print': 'Print',
    'common.downloadPdf': 'Download PDF',
    'common.currency': 'Currency',
    'common.amount': 'Amount',
    'common.vat': 'VAT',
    'common.total': 'Total',
    'common.subtotal': 'Subtotal',
    'common.signature': 'Signature',
    'common.sign': 'Sign',
    'common.signed': 'Signed',
    'common.pending': 'Pending',
    'common.status': 'Status',
    'common.language': 'Language',
    'common.approve': 'Approve',
    'common.reject': 'Reject',
    'common.suspend': 'Suspend',
    'common.reinstate': 'Reinstate',
    'common.search': 'Search',
    'common.actions': 'Actions',
    'common.name': 'Name',
    'common.email': 'Email',
    'common.date': 'Date',
    'common.reference': 'Reference',
    'docs.agreement': 'Agreement',
    'docs.invoice': 'Invoice',
    'docs.agreementTerms': 'Work description and agreed terms',
    'docs.workerParty': 'Worker',
    'docs.businessParty': 'Business / contractor',
    'docs.signatures': 'Signatures',
    'docs.signHere': 'Sign here with your finger or a stylus',
    'docs.clear': 'Clear',
    'docs.signAsWorker': 'Sign as worker',
    'docs.signAsBusiness': 'Sign as business',
    'docs.bothSigned': 'Both parties have signed.',
    'docs.awaiting': 'Waiting for the other party to sign.',
    'docs.companyStamp': 'Company stamp (optional)'
  },
  ar: {
    'brand.tagline': 'الحجز • الاتفاق • الدعم المؤسسي والاجتماعي • إنشاء الفواتير',
    'brand.sub': 'نربط العاملين والشركات ومنظمات الدعم',
    'brand.actions': 'ابحث عن عمل • أبرم اتفاقاً • أنشئ فاتورة',
    'nav.dashboard': 'لوحة التحكم',
    'nav.findWork': 'ابحث عن عمل',
    'nav.applications': 'طلبات التقديم',
    'nav.agreements': 'الاتفاقيات',
    'nav.invoices': 'الفواتير',
    'nav.alerts': 'التنبيهات',
    'nav.profile': 'الملف الشخصي',
    'nav.listings': 'الإعلانات',
    'nav.postWork': 'نشر عمل',
    'nav.workers': 'العاملون',
    'nav.overview': 'نظرة عامة',
    'nav.users': 'المستخدمون',
    'nav.institutions': 'المؤسسات',
    'nav.documents': 'المستندات',
    'nav.reports': 'البلاغات',
    'nav.settings': 'الإعدادات',
    'nav.admin': 'الإدارة',
    'nav.signOut': 'تسجيل الخروج',
    'nav.postWorkShort': 'نشر عمل',
    'nav.help': 'المساعدة',
    'home.worker': 'عامل',
    'home.business': 'منشأة',
    'home.workerCopy': 'ابحث عن عمل، قدّم على الإعلانات، وقّع الاتفاقيات وأنشئ الفواتير — كل ذلك من هاتفك.',
    'home.businessCopy': 'انشر فرص العمل، ابحث عن العاملين، أدر الاتفاقيات وأصدر الفواتير.',
    'home.signUp': 'إنشاء حساب',
    'home.signIn': 'تسجيل الدخول',
    'home.adminLogin': 'دخول الإدارة',
    'home.support': 'المساعدة والدعم',
    'home.supportCopy': 'هل لديك سؤال عن حسابك أو الإعلانات أو الاتفاقيات أو الفواتير؟ راسلنا على',
    'home.institutionTitle': 'الدعم المؤسسي والاجتماعي',
    'home.institutionCopy':
      'يمكن لمنظمات الدعم التسجيل لإدراجها. تُراجع كل عملية تسجيل من قبل الإدارة قبل ظهورها.',
    'home.registerInstitution': 'تسجيل مؤسسة',
    'home.openSupport': 'فتح المساعدة والدعم',
    'auth.email': 'البريد الإلكتروني',
    'auth.password': 'كلمة المرور',
    'auth.fullName': 'الاسم الكامل',
    'auth.phone': 'رقم الهاتف',
    'auth.category': 'فئة العمل / المهارة',
    'auth.city': 'المدينة / المنطقة',
    'auth.aqama': 'رقم الإقامة (اختياري)',
    'auth.aqamaHint': 'يُحفظ آخر 4 أرقام فقط بصيغة مقنّعة.',
    'auth.experience': 'سنوات الخبرة',
    'auth.skills': 'المهارات (مفصولة بفواصل)',
    'auth.bio': 'نبذة مختصرة',
    'auth.company': 'اسم الشركة',
    'auth.contact': 'الشخص المسؤول',
    'auth.country': 'الدولة',
    'auth.address': 'العنوان',
    'auth.website': 'الموقع الإلكتروني (اختياري)',
    'auth.about': 'عن المنشأة',
    'auth.createAccount': 'إنشاء حساب',
    'auth.signIn': 'تسجيل الدخول',
    'auth.signInTitle': 'تسجيل الدخول',
    'auth.forgot': 'نسيت كلمة المرور؟',
    'auth.haveAccount': 'لديك حساب بالفعل؟ سجّل الدخول',
    'auth.createWorker': 'إنشاء حساب عامل',
    'auth.createBusiness': 'إنشاء حساب منشأة',
    'auth.signinNote': 'سجّل الدخول بالبريد الإلكتروني وكلمة المرور التي سجّلت بها.',
    'auth.signupNote': 'يجب إكمال جميع الحقول المطلوبة.',
    'auth.resetTitle': 'إعادة تعيين كلمة المرور',
    'auth.resetSend': 'إرسال رابط إعادة التعيين',
    'auth.resetSent': 'إذا كان البريد مسجلاً، فقد أُرسل رابط إعادة التعيين.',
    'auth.newPassword': 'كلمة المرور الجديدة',
    'auth.confirmPassword': 'تأكيد كلمة المرور',
    'auth.setPassword': 'تعيين كلمة المرور',
    'auth.currentPassword': 'كلمة المرور الحالية',
    'auth.changePassword': 'تغيير كلمة المرور',
    'auth.account': 'الحساب',
    'auth.pending': 'تم استلام تسجيلك وهو بانتظار موافقة الإدارة.',
    'auth.adminOnly': 'تُنشأ حسابات الإدارة من قبل مالك المنصة. لا يوجد تسجيل عام للإدارة.',
    'common.save': 'حفظ',
    'common.cancel': 'إلغاء',
    'common.print': 'طباعة',
    'common.downloadPdf': 'تنزيل PDF',
    'common.currency': 'العملة',
    'common.amount': 'المبلغ',
    'common.vat': 'ضريبة القيمة المضافة',
    'common.total': 'الإجمالي',
    'common.subtotal': 'المجموع الفرعي',
    'common.signature': 'التوقيع',
    'common.sign': 'التوقيع',
    'common.signed': 'موقّع',
    'common.pending': 'قيد الانتظار',
    'common.status': 'الحالة',
    'common.language': 'اللغة',
    'common.approve': 'موافقة',
    'common.reject': 'رفض',
    'common.suspend': 'إيقاف',
    'common.reinstate': 'إعادة تفعيل',
    'common.search': 'بحث',
    'common.actions': 'إجراءات',
    'common.name': 'الاسم',
    'common.email': 'البريد الإلكتروني',
    'common.date': 'التاريخ',
    'common.reference': 'الرقم المرجعي',
    'docs.agreement': 'اتفاقية',
    'docs.invoice': 'فاتورة',
    'docs.agreementTerms': 'وصف العمل والشروط المتفق عليها',
    'docs.workerParty': 'العامل',
    'docs.businessParty': 'المنشأة / المقاول',
    'docs.signatures': 'التوقيعات',
    'docs.signHere': 'وقّع هنا بإصبعك أو بالقلم',
    'docs.clear': 'مسح',
    'docs.signAsWorker': 'التوقيع كعامل',
    'docs.signAsBusiness': 'التوقيع كمنشأة',
    'docs.bothSigned': 'وقّع الطرفان.',
    'docs.awaiting': 'بانتظار توقيع الطرف الآخر.',
    'docs.companyStamp': 'ختم الشركة (اختياري)'
  }
};

const LANG_KEY = 'wb.lang';
let current = 'en';

export function getLang() {
  return current;
}

export function isRtl(lang = current) {
  return lang === 'ar';
}

export function availableLangs() {
  return ['en', 'ar'];
}

export function setLang(lang) {
  current = DICT[lang] ? lang : 'en';
  try {
    localStorage.setItem(LANG_KEY, current);
  } catch {
    /* storage may be unavailable */
  }
  applyDirection();
  return current;
}

export function initLang(preferred) {
  let stored = null;
  try {
    stored = localStorage.getItem(LANG_KEY);
  } catch {
    stored = null;
  }
  current = DICT[stored] ? stored : DICT[preferred] ? preferred : 'en';
  applyDirection();
  return current;
}

export function applyDirection() {
  const root = document.documentElement;
  root.lang = current;
  root.dir = isRtl() ? 'rtl' : 'ltr';
  root.classList.toggle('rtl', isRtl());
}

export function t(key, fallback) {
  return DICT[current]?.[key] ?? DICT.en[key] ?? fallback ?? key;
}

/** Language switcher markup; wires itself on click via the data-lang attribute. */
export function langSwitcher() {
  return `<div class="lang-switch" role="group" aria-label="${t('common.language')}">
    ${availableLangs()
      .map(
        (code) =>
          `<button type="button" data-lang="${code}" class="${code === current ? 'active' : ''}">${
            code === 'ar' ? 'العربية' : 'EN'
          }</button>`
      )
      .join('')}
  </div>`;
}

export function bindLangSwitcher(root, onChange) {
  for (const button of root.querySelectorAll('[data-lang]')) {
    button.addEventListener('click', () => {
      setLang(button.dataset.lang);
      if (typeof onChange === 'function') onChange(getLang());
    });
  }
}
