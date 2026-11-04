# Panduan Setup — Wedding Erik & Oni

Semua langkah di bawah gratis dan tanpa kartu kredit.
Kerjakan berurutan. Tampilan menu di situs pihak ketiga bisa sedikit berbeda dari tulisan di sini.

**Perkiraan waktu:** Bagian 1–3 sekitar 30–45 menit. Bagian 4 (push) sekitar 20 menit, dan bisa dikerjakan belakangan.

---

## Bagian 1 — Taruh aplikasi di internet (GitHub Pages)

1. Buat akun di <https://github.com> kalau belum punya.
2. Klik **+** (kanan atas) → **New repository**.
   - Repository name: `wedding` (boleh nama lain)
   - Pilih **Public** (Pages gratis hanya untuk repo publik)
   - Klik **Create repository**
3. Di halaman repo, klik **uploading an existing file**, lalu seret **seluruh isi** folder aplikasi ini
   (termasuk folder `icons`, `.github`, `worker`, dan `android-assets`). Klik **Commit changes**.
4. Buka tab **Settings** → menu kiri **Pages**:
   - Source: **Deploy from a branch**
   - Branch: **main** / folder **/ (root)** → **Save**
5. Tunggu 1–2 menit, lalu buka alamat yang muncul di halaman itu,
   misalnya `https://namaanda.github.io/wedding/`. **Catat alamat ini.**

> Kode aplikasi bisa dilihat orang karena repo publik. Itu tidak apa-apa:
> data kalian tidak ada di repo. Kode ruang dan konfigurasi Firebase diketik di dalam aplikasi.

---

## Bagian 2 — Data dan sinkronisasi (Firebase Spark, gratis)

1. Buka <https://console.firebase.google.com> → **Add project**.
   Beri nama, misalnya `wedding-erik-oni`. Google Analytics boleh dimatikan.
2. Menu kiri **Build → Firestore Database** → **Create database**
   - Lokasi: pilih yang dekat, misalnya `asia-southeast2` (Jakarta)
   - Mode: **production**
3. Menu kiri **Build → Authentication** → **Get started** →
   tab **Sign-in method** → **Anonymous** → **Enable** → **Save**.
4. Kembali ke **Firestore Database** → tab **Rules**. Hapus isinya, tempel ini, lalu **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /weddings/{room}/{document=**} {
         allow read, write: if request.auth != null && room.size() >= 12;
       }
     }
   }
   ```

5. Klik ikon ⚙️ (kanan atas) → **Project settings** → tab **General** →
   bagian **Your apps** → ikon **web `</>`** → beri nama apa saja → **Register app**.
   Salin bagian `firebaseConfig` (mulai dari `{` sampai `}`).

6. Buka aplikasi di HP Erik (alamat dari Bagian 1) → **Start new** → pilih **Erik**.
7. Tab **Settings** → bagian **Sync Erik ↔ Oni**:
   - Tekan **Generate** (kode ruang dan push secret terisi otomatis)
   - Tempel `firebaseConfig` di kotak **Firebase config**
   - Tekan **Test connection**. Harus muncul ✅. Kalau ❌, pesannya menyebut apa yang kurang.
   - Tekan **Enable sync**

8. **Undang Oni:** Settings → **📨 Share invite ke pasangan** → **Copy** → kirim teksnya lewat chat.
   Di HP Oni: buka alamat yang sama → **Join with invite** → tempel → pilih **Oni**.
   Semua data yang sudah Erik isi langsung muncul, kapan pun Oni bergabung.

> Teks undangan itu rahasia seperti kata sandi. Siapa pun yang punya teks itu bisa membuka data kalian.

---

## Bagian 3 — Jadikan APK (GitHub Actions, gratis)

APK ini hanya cangkang yang memuat aplikasi dari alamat Bagian 1.
Jadi **update tampilan atau fitur cukup diunggah ke GitHub, tanpa memasang APK baru.**

### 3a. Kunci tanda tangan (sangat disarankan, sekali saja)

Supaya APK baru nanti bisa menimpa APK lama tanpa uninstall:

1. Tab **Actions** → pilih **Buat kunci tanda tangan (sekali saja)** → **Run workflow**
2. Isi kata sandi (minimal 8 karakter) → **Run workflow**. **Catat kata sandinya.**
3. Setelah selesai, unduh artifact **keystore-rahasia**, buka `keystore-base64.txt`
4. **Settings → Secrets and variables → Actions → New repository secret**, buat dua secret:
   - `ANDROID_KEYSTORE_B64` = seluruh isi file tadi
   - `ANDROID_KEYSTORE_PASSWORD` = kata sandi tadi
5. Kembali ke halaman run tadi dan **hapus artifact-nya** (ikon tong sampah).
   Penting, karena di repo publik artifact bisa diunduh siapa saja.

Kalau langkah ini dilewati, APK tetap jadi, tetapi setiap kali membuat APK baru
kalian harus uninstall yang lama dulu. Data tetap aman karena tersimpan di cloud.

### 3b. Build APK

1. Tab **Actions** → **Build APK** → **Run workflow**
2. Tunggu sekitar 5–10 menit
3. Unduh **wedding-apk** di bagian **Artifacts**
4. Pasang di HP Erik dan Oni. Android akan bertanya soal "aplikasi tidak dikenal" — izinkan.
   Itu normal untuk APK di luar Play Store.

Setelah dipasang, buka aplikasinya dan lakukan Bagian 2 langkah 6–8 di dalam APK
(atau Join with invite di HP Oni).

---

## Bagian 4 — Notifikasi saat aplikasi tertutup

Ada **dua jenis** notifikasi. Jenis pertama sudah jalan tanpa setup tambahan.

### 4a. Pengingat terjadwal — sudah aktif

Pengingat yang kalian pasang di tugas atau subtugas dijadwalkan di Android,
jadi tetap bunyi walau aplikasi tertutup. Di Settings → Notifications → **Allow notifications**.

Di beberapa HP (Xiaomi, Oppo, Vivo, Huawei) pengaturan hemat baterai bisa menunda pengingat.
Buka pengaturan aplikasi di HP, lalu izinkan **Autostart**, **jalan di latar belakang**,
dan **Alarms & reminders**.

### 4b. Kabar saat pasangan mengubah sesuatu — perlu Cloudflare Worker

Lewati bagian ini kalau belum perlu. Aplikasi tetap jalan penuh tanpanya;
perubahan pasangan tetap muncul saat aplikasi dibuka, lengkap dengan ringkasan
"Sejak terakhir dibuka".

1. **Daftar FCM di Firebase:** ⚙️ **Project settings** → **General** → **Your apps** →
   **Add app** → ikon **Android**
   - Android package name: `com.erikoni.wedding`
   - Unduh **google-services.json**, unggah ke folder `android-assets/` di repo
   - Jalankan **Build APK** sekali lagi, lalu pasang ulang APK-nya

2. **Ambil kunci service account:** ⚙️ **Project settings** → tab **Service accounts** →
   **Generate new private key** → unduh file JSON-nya. Buka file itu, catat tiga hal:
   `project_id`, `client_email`, dan `private_key`.

3. **Buat Worker:**
   - Daftar di <https://dash.cloudflare.com> (hanya email dan kata sandi)
   - Di komputer: buka folder `worker/` dari aplikasi ini, lalu jalankan:
     ```
     npx wrangler login
     npx wrangler deploy
     ```
   - Catat alamat yang muncul, misalnya `https://wedding-push.xxx.workers.dev`

4. **Pasang empat rahasia** (jalankan satu per satu, tempel nilainya saat diminta):
   ```
   npx wrangler secret put SHARED_SECRET
   npx wrangler secret put PROJECT_ID
   npx wrangler secret put SA_CLIENT_EMAIL
   npx wrangler secret put SA_PRIVATE_KEY
   ```
   - `SHARED_SECRET` = isi kotak **Push secret** di Settings aplikasi
   - `PROJECT_ID`, `SA_CLIENT_EMAIL`, `SA_PRIVATE_KEY` = dari file JSON langkah 2
     (untuk `SA_PRIVATE_KEY`, tempel seluruhnya termasuk baris `-----BEGIN PRIVATE KEY-----`)

5. Di aplikasi (kedua HP): Settings → isi **Push URL** dengan alamat Worker →
   **Simpan & sambung ulang**. Lalu buka aplikasi sekali agar HP mendaftarkan dirinya.

**Batas jujurnya:** kabar hanya terkirim kalau HP yang mengedit sedang online
dan aplikasinya terbuka saat itu. Kalau Erik mengedit tanpa internet,
kabarnya menunggu sampai Erik online lagi.

---

## Cara update aplikasi nanti

Ubah file di repo GitHub (atau minta saya kirim file baru, lalu unggah menimpa yang lama).
Aplikasi di HP Erik dan Oni ikut terbarui saat dibuka. **APK tidak perlu dibuat ulang.**

APK baru hanya perlu kalau mengganti ikon, nama aplikasi, atau menambah izin Android.

---

## Apakah data aman saat update?

Ya. Data tersimpan di cloud Firebase, terpisah dari kode aplikasi.
Mengubah tampilan atau menambah fitur tidak menyentuh data.

Agar aman betul:
- Aktifkan sinkronisasi **sebelum** mengisi banyak data
- Simpan kode ruang dan Firebase config di catatan pribadi
- Sesekali **Settings → Download backup (.json)**. Firebase gratis tidak mencadangkan untuk Anda
- Item yang dihapus masuk **Recently deleted** selama 30 hari dan bisa dikembalikan

---

## Batas gratis (dari dokumentasi resmi Firebase)

Firestore paket Spark: penyimpanan 1 GiB, 50.000 baca/hari, 20.000 tulis/hari,
20.000 hapus/hari, 10 GiB trafik keluar/bulan.
Untuk dua orang, ini sangat longgar. Kalau batas terlampaui, layanan berhenti
sampai kuota diatur ulang — **tidak ada tagihan**, karena Spark tidak terhubung kartu.

Foto disimpan terkompresi (±100–200 KB) di Firestore, bukan Cloud Storage,
karena sejak September 2024 Cloud Storage for Firebase memerlukan paket Blaze berbayar.

Cloudflare Workers paket gratis: 100.000 request/hari, 10 ms CPU per request.

Sumber:
- <https://firebase.google.com/docs/firestore/quotas>
- <https://firebase.google.com/docs/projects/billing/firebase-pricing-plans>
- <https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024>
- <https://developers.cloudflare.com/workers/platform/pricing/>

---

## Kalau ada masalah

| Gejala | Kemungkinan sebab |
|---|---|
| Test connection ❌ "Sign-in Anonymous belum diaktifkan" | Bagian 2 langkah 3 belum dikerjakan |
| Test connection ❌ "Rules Firestore menolak" | Bagian 2 langkah 4 belum di-Publish |
| Status di atas tertulis "Local" | Belum tekan **Enable sync**, atau config belum tersimpan |
| Data Oni tidak muncul | Kode ruang berbeda. Pakai **Share invite**, jangan ketik manual |
| Aplikasi terasa berat | Settings → **Effects** → **Light** |
| Pengingat tidak bunyi | Izin notifikasi, atau hemat baterai HP. Lihat Bagian 4a |
| APK tidak bisa dipasang menimpa yang lama | Kunci tanda tangan berbeda. Lihat Bagian 3a, atau uninstall dulu |

---

## Isi folder ini

```
index.html, style.css, app.js, store.js, guide.js   aplikasi
sw.js, manifest.json, icons/                        supaya bisa dipasang
.github/workflows/build-apk.yml                     pembuat APK otomatis
.github/workflows/make-keystore.yml                 pembuat kunci tanda tangan
android-assets/                                     tempat google-services.json
worker/                                             Cloudflare Worker untuk push
package.json                                        daftar plugin Capacitor
```
