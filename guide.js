// Sumber: Sedarlah!—2002 (g02 8/2) hlm. 7, kotak "CONTOH DAFTAR PERIKSA PERSIAPAN".
// Teks butir tugas di bawah disalin apa adanya dari kotak tersebut.
// Kolom "months"/"days" adalah penafsiran aplikasi untuk menghitung tanggal deadline
// dari label waktu (mis. "4 bulan" = 4 bulan sebelum hari H); itu bukan bagian dari sumber.

export const GUIDE_SOURCE = {
  publication: 'Sedarlah!—2002 (g02 8/2), hlm. 4-8',
  article: 'Hari Pernikahan—Membahagiakan tetapi Menguras Tenaga dan Emosi',
  where: 'Kotak "CONTOH DAFTAR PERIKSA PERSIAPAN" di hlm. 7 (kotak, bukan paragraf bernomor)',
  url: 'https://wol.jw.org/id/wol/d/r25/lp-in/102002082',
  footnote: 'Catatan kaki sumber: daftar periksa ini dapat disesuaikan agar cocok dengan tuntutan hukum setempat dan keadaan pribadi.'
};

export const GUIDE = [
  {
    key: 'm6', label: '6 bulan sebelumnya atau lebih', months: 6, days: 0,
    items: [
      'Diskusikan rencana dengan calon suami atau istri, mertua, dan orang tua',
      'Putuskan jenis pesta pernikahan yang diinginkan',
      'Persiapkan anggaran',
      'Pastikan tuntutan-tuntutan hukum',
      'Pesan tempat resepsi',
      'Hubungi juru foto'
    ]
  },
  {
    key: 'm4', label: '4 bulan', months: 4, days: 0,
    items: [
      'Pilih (dari koleksi yang ada), beli, atau jahit pakaian pengantin',
      'Pesan bunga',
      'Pilih dan pesan kartu undangan'
    ]
  },
  {
    key: 'm2', label: '2 bulan', months: 2, days: 0,
    items: [
      'Kirim kartu undangan',
      'Beli cincin',
      'Dapatkan dokumentasi yang perlu'
    ]
  },
  {
    key: 'm1', label: '1 bulan', months: 1, days: 0,
    items: [
      'Mengepas pakaian pengantin',
      'Konfirmasi pesanan dan perjanjian yang telah dibuat',
      'Tulis ucapan terima kasih untuk setiap hadiah yang telah diterima'
    ]
  },
  {
    key: 'w2', label: '2 minggu', months: 0, days: 14,
    items: [
      'Mulailah pindahkan barang-barang pribadi ke rumah yang baru'
    ]
  },
  {
    key: 'w1', label: '1 minggu', months: 0, days: 7,
    items: [
      'Pastikan bahwa semua orang yang membantu tahu apa yang diharapkan dari mereka',
      'Atur pengembalian semua barang yang disewa atau yang dipinjam',
      'Delegasikan semua yang dapat didelegasikan kepada orang lain'
    ]
  }
];

// ID tetap supaya impor dari dua HP tidak membuat tugas dobel.
export const guideTaskId = (groupKey, i) => `guide-${groupKey}-${i}`;
