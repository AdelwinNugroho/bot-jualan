# Bot-Jualan

WhatsApp bot untuk jualan produk fisik & digital.

## Instalasi

```bash
cd bot-jualan
npm install
```

## Menjalankan

```bash
npm start
```

Pilih `pairing` atau `qr` untuk koneksi WhatsApp.

## Setup

1. Edit `config.json` — isi nomor owner
2. Ganti `qris.jpg` dengan foto QRIS kamu
3. Tambah produk via command `.addproduk`
4. Tambah stok digital via `.addstok`

## Command Pembeli

| Command | Fungsi |
|---|---|
| `.menu` | Lihat menu |
| `.shop` | Lihat katalog produk |
| `.detail <kode>` | Detail produk |
| `.beli <kode> <jumlah>` | Buat pesanan |
| `.payment <id>` | Tampilkan QRIS pembayaran |
| `.orders` | Lihat pesanan saya |
| `.batal <id>` | Batalkan order |

## Command Owner

| Command | Fungsi |
|---|---|
| `.addproduk kode\|nama\|tipe\|harga\|stok\|deskripsi` | Tambah produk |
| `.delproduk <kode>` | Hapus produk |
| `.addstok <kode> <nilai>` | Tambah stok (digital: email\|pass, fisik: angka) |
| `.listorder` | Lihat semua order |
| `.acc <id>` | Konfirmasi pembayaran |
| `.tolak <id>` | Tolak order |

## Alur Transaksi

```
Buyer .beli → order pending + notif owner
Buyer .payment → QRIS + total
Buyer bayar via e-wallet
Owner .acc → stok berkurang → akun otomatis terkirim (digital) / koordinasi kirim (fisik)
```
