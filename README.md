# Forma — Auto Editor

Auto editor lokal untuk video produk bergaya minimal, berdasarkan `apple_style_editing_sop.md`: latar hitam/putih, tipografi Inter, negative space, animasi Bezier, hard cut mengikuti beat, dan reveal yang lebih lambat.

## Menjalankan

Kebutuhan: Node.js 22 atau lebih baru, FFmpeg + FFprobe dalam `PATH`, dan Chromium. Lingkungan cloud ini sudah menyediakan ketiganya.

```bash
cd /workspace/Auto-editor
npm ci
npm run dev
```

Server memakai port `3000` dan bind ke `127.0.0.1`. Untuk akses melalui host lain, jalankan `HOST=0.0.0.0 npm run dev`. Untuk build produksi:

```bash
npm run build
npm start
```

`PORT`, `HOST`, `CHROME_PATH`, dan `AUTO_EDITOR_DATA_DIR` dapat diberikan sebagai environment variable. `CHROME_PATH` default memakai `/usr/bin/chromium` bila tersedia. Tidak perlu API key. Gunakan checkout yang sudah ada; setiap tugas cloud sudah terisolasi sehingga tidak perlu Git worktree.

## Alur penggunaan

1. Klik **Muat demo** untuk mencoba footage produk dan musik sintetis original, atau unggah video B-roll dan satu musik.
2. Pilih footage dan musik, lalu tentukan judul, subjudul, latar, rasio, dan durasi.
3. Susun edit otomatis. Aplikasi menganalisis musik dan memberi urutan footage berdasarkan skor visual.
4. Putar pratinjau atau klik bagian timeline untuk memeriksa hasil. Perubahan pengaturan memerlukan penyusunan ulang sebelum ekspor.
5. Ekspor MP4, tunggu progres selesai, lalu unduh hasilnya. Ekspor dapat dibatalkan.

Unggahan: MP4, MOV, WebM, MKV, AVI untuk video; MP3, WAV, M4A, AAC, OGG, FLAC untuk audio. Batas 12 berkas per unggahan, 250 MB per berkas, sumber hingga 10 menit. Video dinormalisasi menjadi H.264, audio menjadi PCM WAV agar dapat dipratinjau dan diproses secara konsisten. Suara asli B-roll tidak digunakan.

## Perilaku editing

- Musik dianalisis dari sampel audio: onset energi, autokorelasi tempo, dan koreksi posisi beat lokal. Jika musik tidak ada atau tidak cukup ritmis, aplikasi memberi peringatan dan menggunakan BPM manual.
- Timeline 6–60 detik pada 30 fps. Durasi dapat dipendekkan ke panjang musik atau beat terakhir. Batas potongan dibulatkan ke frame terdekat.
- Opening tipografi, rangkaian potongan cepat, reveal lebih lama, dan closing. Rasio 16:9, 9:16, dan 1:1; ekspor H.264/AAC pada 1080p.
- Tiga sampel per video dinilai berdasarkan kontras, perbedaan luminansi pusat/tepi, dan kerumitan visual. Ini heuristik visual, bukan pengenalan objek atau penilaian estetika AI.
- Judul masuk dengan mask dan ease-out, drift lembut, tracking rapat, serta maksimal dua elemen fokus. Tema mengatur kartu tipografi dan kanvas; warna asli footage dipertahankan.
- Musik turun hingga hening sebelum reveal, lalu kembali; SFX tap yang halus dapat dinonaktifkan. Pratinjau dan ekspor memakai komposisi dan envelope audio yang sama.
- Kecepatan berbeda antar-shot. Sumber yang terlalu pendek untuk playback aman ditahan sebagai still frame dengan drift halus, disertai peringatan. Belum ada speed ramp kontinu dalam satu shot, optical-flow slow motion, penghilangan latar, stabilisasi, pemilihan sudut kamera semantik, ataupun transkripsi/caption otomatis. Gerakan dan pencahayaan sumber tetap menentukan kualitas akhir.

## Penyimpanan dan proses

Media ternormalisasi, thumbnail, manifest, dan hasil ekspor disimpan di `.data/` (diabaikan Git). Berkas diproses oleh mesin yang menjalankan aplikasi, tanpa dikirim ke layanan AI. Metadata library bertahan setelah server restart. Rencana timeline dan status job berada di memori; susun ulang edit setelah restart. Ekspor dijalankan satu per satu dengan dua worker render.

Ini aplikasi untuk satu pengguna di lingkungan pengembangan. Untuk deployment publik, tambahkan autentikasi, isolasi penyimpanan antar-pengguna, kuota dan pembersihan berkas. Menyetel `HOST=0.0.0.0` membuka akses jaringan sesuai konfigurasi host.

## Validasi

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
# Opsional: regresi trim sumber dengan render nyata
RUN_RENDER_TESTS=1 npm test
```

Pengujian E2E menyalakan server terpisah, membuat media demo, menguji unggahan dan validasi input, membuat timeline, merender MP4, memeriksa stream/durasi/audio, lalu memeriksa antarmuka dengan Chromium. Tidak membutuhkan server yang sudah berjalan.

Struktur: `web/` antarmuka React, `shared/` kontrak data, `server/` analisis/penyimpanan/HTTP/render, `video/` komposisi Remotion, `tests/` pengujian. Dependensi dikunci dalam `package-lock.json`.
