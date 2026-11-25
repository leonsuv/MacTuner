#!/usr/bin/env node
/**
 * Builds web/apps/studio/src/lib/locales.json from:
 *  1. All 25 native macOS Localization/*.lproj/Localizable.strings files
 *  2. REACT_UI_STRINGS covering all React Studio UI labels across all 25 locales
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const LOCALIZATION_DIR = path.join(ROOT_DIR, 'Localization');
const OUTPUT_PATH = path.join(ROOT_DIR, 'web/apps/studio/src/lib/locales.json');

const LOCALE_NAMES = {
  bg: 'Български',
  cs: 'Čeština',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  hr: 'Hrvatski',
  hu: 'Magyar',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  ro: 'Română',
  ru: 'Русский',
  sl: 'Slovenščina',
  sq: 'Shqip',
  sr: 'Srpski',
  sv: 'Svenska',
  tr: 'Türkçe',
  uk: 'Українська',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
};

const ALL_LOCALES = Object.keys(LOCALE_NAMES);

/**
 * Unescape Apple .strings escape sequences: \", \n, \r, \t, \\
 */
function unescapeAppleString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') {
        out += '\n';
        i++;
      } else if (next === 'r') {
        out += '\r';
        i++;
      } else if (next === 't') {
        out += '\t';
        i++;
      } else if (next === '"' || next === '\\') {
        out += next;
        i++;
      } else {
        out += next;
        i++;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Parse a Localizable.strings file into a Map<swiftKey, value>.
 */
function parseStringsFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const map = new Map();
  const lineRe = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;\s*$/;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
    const match = lineRe.exec(line);
    if (match) {
      map.set(unescapeAppleString(match[1]), unescapeAppleString(match[2]));
    }
  }
  return map;
}

/**
 * Comprehensive React Studio UI translations across all 25 languages.
 * Indexed by English key -> { [localeCode]: localizedString }.
 */
const REACT_UI_STRINGS = {
  // Top nav tabs
  'Overview': {
    bg: 'Преглед', cs: 'Přehled', de: 'Übersicht', el: 'Επισκόπηση', en: 'Overview',
    es: 'Resumen', fr: 'Aperçu', hr: 'Pregled', hu: 'Áttekintés', it: 'Panoramica',
    ja: '概要', ko: '개요', nl: 'Overzicht', pl: 'Przegląd', pt: 'Visão Geral',
    ro: 'Prezentare', ru: 'Обзор', sl: 'Pregled', sq: 'Përmbledhje', sr: 'Pregled',
    sv: 'Översikt', tr: 'Genel Bakış', uk: 'Огляд', 'zh-Hans': '概览', 'zh-Hant': '概覽',
  },
  'Workspace': {
    bg: 'Работна площ', cs: 'Pracovní plocha', de: 'Arbeitsbereich', el: 'Χώρος εργασίας', en: 'Workspace',
    es: 'Espacio de trabajo', fr: 'Espace de travail', hr: 'Radni prostor', hu: 'Munkaterület', it: 'Spazio di lavoro',
    ja: 'ワークスペース', ko: '작업 공간', nl: 'Werkruimte', pl: 'Obszar roboczy', pt: 'Área de trabalho',
    ro: 'Spațiu de lucru', ru: 'Рабочая область', sl: 'Delovni prostor', sq: 'Hapësira e punës', sr: 'Radni prostor',
    sv: 'Arbetsyta', tr: 'Çalışma Alanı', uk: 'Робоча область', 'zh-Hans': '工作区', 'zh-Hant': '工作區',
  },
  'Compare': {
    bg: 'Сравнение', cs: 'Porovnání', de: 'Vergleich', el: 'Σύγκριση', en: 'Compare',
    es: 'Comparar', fr: 'Comparer', hr: 'Usporedi', hu: 'Összehasonlítás', it: 'Confronta',
    ja: '比較', ko: '비교', nl: 'Vergelijken', pl: 'Porównaj', pt: 'Comparar',
    ro: 'Compară', ru: 'Сравнение', sl: 'Primerjava', sq: 'Krahaso', sr: 'Uporedi',
    sv: 'Jämför', tr: 'Karşılaştır', uk: 'Порівняння', 'zh-Hans': '对比', 'zh-Hant': '對比',
  },
  'Discovery': {
    bg: 'Откриване', cs: 'Vyhledávání', de: 'Erkennung', el: 'Ανακάλυψη', en: 'Discovery',
    es: 'Descubrimiento', fr: 'Découverte', hr: 'Otkrivanje', hu: 'Felderítés', it: 'Rilevamento',
    ja: '探索', ko: '탐색', nl: 'Detectie', pl: 'Wykrywanie', pt: 'Descoberta',
    ro: 'Detectare', ru: 'Поиск карт', sl: 'Odkrivanje', sq: 'Zbulim', sr: 'Otkrivanje',
    sv: 'Upptäckt', tr: 'Keşif', uk: 'Пошук карт', 'zh-Hans': '发现', 'zh-Hant': '探索',
  },
  'Memory': {
    bg: 'Памет', cs: 'Paměť', de: 'Speicher', el: 'Μνήμη', en: 'Memory',
    es: 'Memoria', fr: 'Mémoire', hr: 'Memorija', hu: 'Memória', it: 'Memoria',
    ja: 'メモリ', ko: '메모리', nl: 'Geheugen', pl: 'Pamięć', pt: 'Memória',
    ro: 'Memorie', ru: 'Память', sl: 'Pomnilnik', sq: 'Memoria', sr: 'Memorija',
    sv: 'Minne', tr: 'Bellek', uk: 'Памʼять', 'zh-Hans': '内存', 'zh-Hant': '記憶體',
  },
  'Recipes': {
    bg: 'Рецепти', cs: 'Recepty', de: 'Rezepte', el: 'Συνταγές', en: 'Recipes',
    es: 'Recetas', fr: 'Recettes', hr: 'Recepti', hu: 'Receptek', it: 'Ricette',
    ja: 'レシピ', ko: '레시피', nl: 'Recepten', pl: 'Receptury', pt: 'Receitas',
    ro: 'Rețete', ru: 'Рецепты', sl: 'Recepti', sq: 'Receta', sr: 'Recepti',
    sv: 'Recept', tr: 'Reçeteler', uk: 'Рецепти', 'zh-Hans': '方案', 'zh-Hant': '方案',
  },
  'Datalog': {
    bg: 'Даталог', cs: 'Datalog', de: 'Datalog', el: 'Καταγραφή', en: 'Datalog',
    es: 'Registro', fr: 'Datalog', hr: 'Datalog', hu: 'Adatnapló', it: 'Datalog',
    ja: 'データログ', ko: '데이터로그', nl: 'Datalog', pl: 'Datalog', pt: 'Datalog',
    ro: 'Datalog', ru: 'Даталог', sl: 'Datalog', sq: 'Datalog', sr: 'Datalog',
    sv: 'Datalog', tr: 'Veri Günlüğü', uk: 'Даталог', 'zh-Hans': '数据日志', 'zh-Hant': '數據日誌',
  },
  'Flash': {
    bg: 'Флаш', cs: 'Flash', de: 'Flash', el: 'Flash', en: 'Flash',
    es: 'Flash', fr: 'Flash', hr: 'Flash', hu: 'Flash', it: 'Flash',
    ja: 'フラッシュ', ko: '플래시', nl: 'Flash', pl: 'Flash', pt: 'Flash',
    ro: 'Flash', ru: 'Прошивка', sl: 'Flash', sq: 'Flash', sr: 'Flash',
    sv: 'Flash', tr: 'Flash', uk: 'Прошивка', 'zh-Hans': '刷写', 'zh-Hant': '刷寫',
  },

  // Web Menu Bar
  'File': {
    bg: 'Файл', cs: 'Soubor', de: 'Ablage', el: 'Αρχείο', en: 'File',
    es: 'Archivo', fr: 'Fichier', hr: 'Datoteka', hu: 'Fájl', it: 'File',
    ja: 'ファイル', ko: '파일', nl: 'Bestand', pl: 'Plik', pt: 'Arquivo',
    ro: 'Fișier', ru: 'Файл', sl: 'Datoteka', sq: 'Skedar', sr: 'Datoteka',
    sv: 'Arkiv', tr: 'Dosya', uk: 'Файл', 'zh-Hans': '文件', 'zh-Hant': '檔案',
  },
  'Edit': {
    bg: 'Редактиране', cs: 'Upravit', de: 'Bearbeiten', el: 'Επεξεργασία', en: 'Edit',
    es: 'Edición', fr: 'Édition', hr: 'Uredi', hu: 'Szerkesztés', it: 'Modifica',
    ja: '編集', ko: '편집', nl: 'Bewerken', pl: 'Edycja', pt: 'Editar',
    ro: 'Editare', ru: 'Правка', sl: 'Uredi', sq: 'Redakto', sr: 'Uredi',
    sv: 'Redigera', tr: 'Düzenle', uk: 'Редагування', 'zh-Hans': '编辑', 'zh-Hant': '編輯',
  },
  'View': {
    bg: 'Изглед', cs: 'Zobrazení', de: 'Darstellung', el: 'Προβολή', en: 'View',
    es: 'Ver', fr: 'Présentation', hr: 'Prikaz', hu: 'Nézet', it: 'Vista',
    ja: '表示', ko: '보기', nl: 'Weergave', pl: 'Widok', pt: 'Exibir',
    ro: 'Vizualizare', ru: 'Вид', sl: 'Pogled', sq: 'Pamje', sr: 'Prikaz',
    sv: 'Innehåll', tr: 'Görünüm', uk: 'Вигляд', 'zh-Hans': '视图', 'zh-Hant': '檢視',
  },
  'Tools': {
    bg: 'Инструменти', cs: 'Nástroje', de: 'Werkzeuge', el: 'Εργαλεία', en: 'Tools',
    es: 'Herramientas', fr: 'Outils', hr: 'Alati', hu: 'Eszközök', it: 'Strumenti',
    ja: 'ツール', ko: '도구', nl: 'Hulpmiddelen', pl: 'Narzędzia', pt: 'Ferramentas',
    ro: 'Unelte', ru: 'Инструменты', sl: 'Orodja', sq: 'Mjete', sr: 'Alati',
    sv: 'Verktyg', tr: 'Araçlar', uk: 'Інструменти', 'zh-Hans': '工具', 'zh-Hant': '工具',
  },
  'Window': {
    bg: 'Прозорец', cs: 'Okno', de: 'Fenster', el: 'Παράθυρο', en: 'Window',
    es: 'Ventana', fr: 'Fenêtre', hr: 'Prozor', hu: 'Ablak', it: 'Finestra',
    ja: 'ウインドウ', ko: '윈도우', nl: 'Venster', pl: 'Okno', pt: 'Janela',
    ro: 'Fereastră', ru: 'Окно', sl: 'Okno', sq: 'Dritare', sr: 'Prozor',
    sv: 'Fönster', tr: 'Pencere', uk: 'Вікно', 'zh-Hans': '窗口', 'zh-Hant': '視窗',
  },
  'Open BIN…': {
    bg: 'Отвори BIN…', cs: 'Otevřít BIN…', de: 'BIN öffnen…', el: 'Άνοιγμα BIN…', en: 'Open BIN…',
    es: 'Abrir BIN…', fr: 'Ouvrir BIN…', hr: 'Otvori BIN…', hu: 'BIN megnyitása…', it: 'Apri BIN…',
    ja: 'BINを開く…', ko: 'BIN 열기…', nl: 'BIN openen…', pl: 'Otwórz BIN…', pt: 'Abrir BIN…',
    ro: 'Deschide BIN…', ru: 'Открыть BIN…', sl: 'Odpri BIN…', sq: 'Hap BIN…', sr: 'Otvori BIN…',
    sv: 'Öppna BIN…', tr: 'BIN Aç…', uk: 'Відкрити BIN…', 'zh-Hans': '打开 BIN…', 'zh-Hant': '開啟 BIN…',
  },
  'Open Compare BIN…': {
    bg: 'Отвори сравнителен BIN…', cs: 'Otevřít srovnávací BIN…', de: 'Vergleichs-BIN öffnen…', el: 'Άνοιγμα BIN σύγκρισης…', en: 'Open Compare BIN…',
    es: 'Abrir BIN de comparación…', fr: 'Ouvrir BIN de comparaison…', hr: 'Otvori usporedni BIN…', hu: 'Összehasonlító BIN megnyitása…', it: 'Apri BIN di confronto…',
    ja: '比較BINを開く…', ko: '비교 BIN 열기…', nl: 'Vergelijkings-BIN openen…', pl: 'Otwórz BIN porównawczy…', pt: 'Abrir BIN de comparação…',
    ro: 'Deschide BIN de comparație…', ru: 'Открыть BIN для сравнения…', sl: 'Odpri primerjalni BIN…', sq: 'Hap BIN krahasimi…', sr: 'Otvori BIN za poređenje…',
    sv: 'Öppna jämförelse-BIN…', tr: 'Karşılaştırma BIN Aç…', uk: 'Відкрити BIN для порівняння…', 'zh-Hans': '打开对比 BIN…', 'zh-Hant': '開啟對比 BIN…',
  },
  'Open Definition…': {
    bg: 'Отвори дефиниция…', cs: 'Otevřít definici…', de: 'Definition öffnen…', el: 'Άνοιγμα ορισμού…', en: 'Open Definition…',
    es: 'Abrir definición…', fr: 'Ouvrir une définition…', hr: 'Otvori definiciju…', hu: 'Definíció megnyitása…', it: 'Apri definizione…',
    ja: '定義を開く…', ko: '정의 열기…', nl: 'Definitie openen…', pl: 'Otwórz definicję…', pt: 'Abrir definição…',
    ro: 'Deschide definiția…', ru: 'Открыть определение…', sl: 'Odpri definicijo…', sq: 'Hap definicionin…', sr: 'Otvori definiciju…',
    sv: 'Öppna definition…', tr: 'Tanım Aç…', uk: 'Відкрити визначення…', 'zh-Hans': '打开定义文件…', 'zh-Hant': '開啟定義檔…',
  },
  'Smart-Merge Definition…': {
    bg: 'Умно сливане на дефиниция…', cs: 'Chytré sloučení definice…', de: 'Definition intelligent zusammenführen…', el: 'Έξυπνη συγχώνευση ορισμού…', en: 'Smart-Merge Definition…',
    es: 'Fusión inteligente de definición…', fr: 'Fusion intelligente de définition…', hr: 'Pametno spajanje definicije…', hu: 'Definíció okos egyesítése…', it: 'Unisci definizione…',
    ja: '定義をスマート統合…', ko: '정의 스마트 병합…', nl: 'Definitie slim samenvoegen…', pl: 'Inteligentne scalanie definicji…', pt: 'Mesclar definição…',
    ro: 'Îmbinare inteligentă definiție…', ru: 'Умное слияние определения…', sl: 'Pametno združevanje definicije…', sq: 'Bashkim inteligjent i definicionit…', sr: 'Pametno spajanje definicije…',
    sv: 'Smart-sammanfoga definition…', tr: 'Tanımı Akıllı Birleştir…', uk: 'Розумне обʼєднання визначення…', 'zh-Hans': '智能合并定义…', 'zh-Hant': '智慧合併定義…',
  },
  'Open Project…': {
    bg: 'Отвори проект…', cs: 'Otevřít projekt…', de: 'Projekt öffnen…', el: 'Άνοιγμα έργου…', en: 'Open Project…',
    es: 'Abrir proyecto…', fr: 'Ouvrir le projet…', hr: 'Otvori projekt…', hu: 'Projekt megnyitása…', it: 'Apri progetto…',
    ja: 'プロジェクトを開く…', ko: '프로젝트 열기…', nl: 'Project openen…', pl: 'Otwórz projekt…', pt: 'Abrir projeto…',
    ro: 'Deschide proiect…', ru: 'Открыть проект…', sl: 'Odpri projekt…', sq: 'Hap projektin…', sr: 'Otvori projekat…',
    sv: 'Öppna projekt…', tr: 'Proje Aç…', uk: 'Відкрити проєкт…', 'zh-Hans': '打开项目…', 'zh-Hant': '開啟專案…',
  },
  'Save Project': {
    bg: 'Запази проект', cs: 'Uložit projekt', de: 'Projekt speichern', el: 'Αποθήκευση έργου', en: 'Save Project',
    es: 'Guardar proyecto', fr: 'Enregistrer le projet', hr: 'Spremi projekt', hu: 'Projekt mentése', it: 'Salva progetto',
    ja: 'プロジェクトを保存', ko: '프로젝트 저장', nl: 'Project opslaan', pl: 'Zapisz projekt', pt: 'Salvar projeto',
    ro: 'Salvează proiectul', ru: 'Сохранить проект', sl: 'Shrani projekt', sq: 'Ruaj projektin', sr: 'Sačuvaj projekat',
    sv: 'Spara projekt', tr: 'Projeyi Kaydet', uk: 'Зберегти проєкт', 'zh-Hans': '保存项目', 'zh-Hant': '儲存專案',
  },
  'Export BIN…': {
    bg: 'Експортирай BIN…', cs: 'Exportovat BIN…', de: 'BIN exportieren…', el: 'Εξαγωγή BIN…', en: 'Export BIN…',
    es: 'Exportar BIN…', fr: 'Exporter BIN…', hr: 'Izvezi BIN…', hu: 'BIN exportálása…', it: 'Esporta BIN…',
    ja: 'BINを書き出す…', ko: 'BIN 내보내기…', nl: 'BIN exporteren…', pl: 'Eksportuj BIN…', pt: 'Exportar BIN…',
    ro: 'Exportă BIN…', ru: 'Экспорт BIN…', sl: 'Izvozi BIN…', sq: 'Eksporto BIN…', sr: 'Izvezi BIN…',
    sv: 'Exportera BIN…', tr: 'BIN Dışa Aktar…', uk: 'Експортувати BIN…', 'zh-Hans': '导出 BIN…', 'zh-Hant': '匯出 BIN…',
  },
  'Export BIN': {
    bg: 'Експортирай BIN', cs: 'Exportovat BIN', de: 'BIN exportieren', el: 'Εξαγωγή BIN', en: 'Export BIN',
    es: 'Exportar BIN', fr: 'Exporter BIN', hr: 'Izvezi BIN', hu: 'BIN exportálása', it: 'Esporta BIN',
    ja: 'BINを書き出す', ko: 'BIN 내보내기', nl: 'BIN exporteren', pl: 'Eksportuj BIN', pt: 'Exportar BIN',
    ro: 'Exportă BIN', ru: 'Экспорт BIN', sl: 'Izvozi BIN', sq: 'Eksporto BIN', sr: 'Izvezi BIN',
    sv: 'Exportera BIN', tr: 'BIN Dışa Aktar', uk: 'Експортувати BIN', 'zh-Hans': '导出 BIN', 'zh-Hant': '匯出 BIN',
  },
  'Export Intel HEX (.hex)': {
    bg: 'Експорт Intel HEX (.hex)', cs: 'Exportovat Intel HEX (.hex)', de: 'Intel HEX exportieren (.hex)', el: 'Εξαγωγή Intel HEX (.hex)', en: 'Export Intel HEX (.hex)',
    es: 'Exportar Intel HEX (.hex)', fr: 'Exporter Intel HEX (.hex)', hr: 'Izvezi Intel HEX (.hex)', hu: 'Intel HEX exportálása (.hex)', it: 'Esporta Intel HEX (.hex)',
    ja: 'Intel HEX書き出し (.hex)', ko: 'Intel HEX 내보내기 (.hex)', nl: 'Intel HEX exporteren (.hex)', pl: 'Eksportuj Intel HEX (.hex)', pt: 'Exportar Intel HEX (.hex)',
    ro: 'Exportă Intel HEX (.hex)', ru: 'Экспорт Intel HEX (.hex)', sl: 'Izvozi Intel HEX (.hex)', sq: 'Eksporto Intel HEX (.hex)', sr: 'Izvezi Intel HEX (.hex)',
    sv: 'Exportera Intel HEX (.hex)', tr: 'Intel HEX Dışa Aktar (.hex)', uk: 'Експорт Intel HEX (.hex)', 'zh-Hans': '导出 Intel HEX (.hex)', 'zh-Hant': '匯出 Intel HEX (.hex)',
  },
  'Export Motorola S-Record (.s19)': {
    bg: 'Експорт Motorola S-Record (.s19)', cs: 'Exportovat Motorola S-Record (.s19)', de: 'Motorola S-Record exportieren (.s19)', el: 'Εξαγωγή Motorola S-Record (.s19)', en: 'Export Motorola S-Record (.s19)',
    es: 'Exportar Motorola S-Record (.s19)', fr: 'Exporter Motorola S-Record (.s19)', hr: 'Izvezi Motorola S-Record (.s19)', hu: 'Motorola S-Record exportálása (.s19)', it: 'Esporta Motorola S-Record (.s19)',
    ja: 'Motorola S-Record書き出し (.s19)', ko: 'Motorola S-Record 내보내기 (.s19)', nl: 'Motorola S-Record exporteren (.s19)', pl: 'Eksportuj Motorola S-Record (.s19)', pt: 'Exportar Motorola S-Record (.s19)',
    ro: 'Exportă Motorola S-Record (.s19)', ru: 'Экспорт Motorola S-Record (.s19)', sl: 'Izvozi Motorola S-Record (.s19)', sq: 'Eksporto Motorola S-Record (.s19)', sr: 'Izvezi Motorola S-Record (.s19)',
    sv: 'Exportera Motorola S-Record (.s19)', tr: 'Motorola S-Record Dışa Aktar (.s19)', uk: 'Експорт Motorola S-Record (.s19)', 'zh-Hans': '导出 Motorola S-Record (.s19)', 'zh-Hant': '匯出 Motorola S-Record (.s19)',
  },
  'Print / Save PDF…': {
    bg: 'Печат / Запази PDF…', cs: 'Tisk / Uložit PDF…', de: 'Drucken / Als PDF sichern…', el: 'Εκτύπωση / Αποθήκευση PDF…', en: 'Print / Save PDF…',
    es: 'Imprimir / Guardar PDF…', fr: 'Imprimer / Enregistrer en PDF…', hr: 'Ispis / Spremi PDF…', hu: 'Nyomtatás / Mentés PDF-ként…', it: 'Stampa / Salva PDF…',
    ja: 'プリント / PDFで保存…', ko: '인쇄 / PDF 저장…', nl: 'Afdrukken / Opslaan als PDF…', pl: 'Drukuj / Zapisz PDF…', pt: 'Imprimir / Salvar PDF…',
    ro: 'Tipărește / Salvează PDF…', ru: 'Печать / Сохранить PDF…', sl: 'Natisni / Shrani PDF…', sq: 'Printo / Ruaj PDF…', sr: 'Štampaj / Sačuvaj PDF…',
    sv: 'Skriv ut / Spara PDF…', tr: 'Yazdır / PDF Kaydet…', uk: 'Друк / Зберегти PDF…', 'zh-Hans': '打印 / 保存为 PDF…', 'zh-Hant': '列印 / 儲存為 PDF…',
  },
  'Check for Updates…': {
    bg: 'Провери за обновления…', cs: 'Zkontrolovat aktualizace…', de: 'Nach Updates suchen…', el: 'Έλεγχος για ενημερώσεις…', en: 'Check for Updates…',
    es: 'Buscar actualizaciones…', fr: 'Rechercher des mises à jour…', hr: 'Provjeri ažuriranja…', hu: 'Frissítések keresése…', it: 'Verifica aggiornamenti…',
    ja: 'アップデートを確認…', ko: '업데이트 확인…', nl: 'Controleren op updates…', pl: 'Sprawdź aktualizacje…', pt: 'Verificar atualizações…',
    ro: 'Verifică actualizări…', ru: 'Проверить обновления…', sl: 'Preveri posodobitve…', sq: 'Kontrollo për përditësime…', sr: 'Proveri ažuriranja…',
    sv: 'Sök efter uppdateringar…', tr: 'Güncellemeleri Denetle…', uk: 'Перевірити оновлення…', 'zh-Hans': '检查更新…', 'zh-Hant': '檢查更新…',
  },
  'Load Demo Workspace': {
    bg: 'Зареди демо проект', cs: 'Načíst demo pracovní plochu', de: 'Demo-Arbeitsbereich laden', el: 'Φόρτωση δοκιμαστικού χώρου', en: 'Load Demo Workspace',
    es: 'Cargar espacio demo', fr: 'Charger l’espace de démo', hr: 'Učitaj demo radni prostor', hu: 'Demó munkaterület betöltése', it: 'Carica spazio demo',
    ja: 'デモワークスペースを読み込む', ko: '데모 작업 공간 불러오기', nl: 'Demo-werkruimte laden', pl: 'Wczytaj obszar demo', pt: 'Carregar espaço de demonstração',
    ro: 'Încarcă spațiul demo', ru: 'Загрузить демо-проект', sl: 'Naloži demo delovni prostor', sq: 'Ngarko hapësirën demo', sr: 'Učitaj demo radni prostor',
    sv: 'Ladda demoarbetsyta', tr: 'Demo Çalışma Alanını Yükle', uk: 'Завантажити демо-проєкт', 'zh-Hans': '加载演示工作区', 'zh-Hant': '載入示範工作區',
  },
  'Swap Active & Comparison BIN': {
    bg: 'Размени активен и сравнителен BIN', cs: 'Prohodit aktivní a srovnávací BIN', de: 'Aktive & Vergleichs-BIN tauschen', el: 'Εναλλαγή ενεργού & BIN σύγκρισης', en: 'Swap Active & Comparison BIN',
    es: 'Intercambiar BIN activo y de comparación', fr: 'Inverser BIN actif et de comparaison', hr: 'Zamijeni aktivni i usporedni BIN', hu: 'Aktív és összehasonlító BIN cseréje', it: 'Scambia BIN attivo e di confronto',
    ja: 'アクティブBINと比較BINを入れ替え', ko: '활성 및 비교 BIN 교체', nl: 'Actieve & vergelijkings-BIN wisselen', pl: 'Zamień aktywny i porównawczy BIN', pt: 'Trocar BIN ativo e de comparação',
    ro: 'Schimbă BIN activ și de comparație', ru: 'Поменять активный и сравнительный BIN', sl: 'Zamenjaj aktivni in primerjalni BIN', sq: 'Ndërro BIN aktiv dhe krahasues', sr: 'Zameni aktivni i poređeni BIN',
    sv: 'Byt aktiv och jämförelse-BIN', tr: 'Aktif ve Karşılaştırma BIN’i Değiştir', uk: 'Поміняти активний і порівняльний BIN', 'zh-Hans': '交换当前与对比 BIN', 'zh-Hant': '交換目前與對比 BIN',
  },
  'Toggle Favorite': {
    bg: 'Превключи любими', cs: 'Přepnout oblíbené', de: 'Favorit umschalten', el: 'Εναλλαγή αγαπημένου', en: 'Toggle Favorite',
    es: 'Alternar favorito', fr: 'Basculer le favori', hr: 'Uključi/isključi favorit', hu: 'Kedvenc váltása', it: 'Attiva/disattiva preferito',
    ja: 'お気に入りを切り替え', ko: '즐겨찾기 전환', nl: 'Favoriet schakelen', pl: 'Przełącz ulubione', pt: 'Alternar favorito',
    ro: 'Comută favorit', ru: 'Переключить избранное', sl: 'Preklopi priljubljeno', sq: 'Ndërro të preferuarin', sr: 'Prebaci omiljeno',
    sv: 'Växla favorit', tr: 'Favoriyi Değiştir', uk: 'Перемкнути обране', 'zh-Hans': '切换收藏', 'zh-Hant': '切換收藏',
  },
  'Toggle Map Lock': {
    bg: 'Превключи заключване на карта', cs: 'Přepnout zámek mapy', de: 'Kennfeldsperre umschalten', el: 'Εναλλαγή κλειδώματος χάρτη', en: 'Toggle Map Lock',
    es: 'Alternar bloqueo de mapa', fr: 'Basculer le verrouillage de carte', hr: 'Uključi/isključi zaključavanje mape', hu: 'Térkép zárolás váltása', it: 'Attiva/disattiva blocco mappa',
    ja: 'マップロックを切り替え', ko: '맵 잠금 전환', nl: 'Mapvergrendeling schakelen', pl: 'Przełącz blokadę mapy', pt: 'Alternar bloqueio do mapa',
    ro: 'Comută blocarea hărții', ru: 'Переключить блокировку карты', sl: 'Preklopi zaklep mape', sq: 'Ndërro kyçjen e hartës', sr: 'Prebaci zaključavanje mape',
    sv: 'Växla kartlås', tr: 'Harita Kilidini Değiştir', uk: 'Перемкнути блокування карти', 'zh-Hans': '切换图谱锁定', 'zh-Hant': '切換圖譜鎖定',
  },
  'Toggle Bottom Drawer': {
    bg: 'Превключи долния панел', cs: 'Přepnout spodní panel', de: 'Unteren Bereich umschalten', el: 'Εναλλαγή κάτω πλαισίου', en: 'Toggle Bottom Drawer',
    es: 'Alternar panel inferior', fr: 'Basculer le tiroir inférieur', hr: 'Uključi/isključi donju ladicu', hu: 'Alsó panel váltása', it: 'Attiva/disattiva pannello inferiore',
    ja: '下部ドロワーを切り替え', ko: '하단 패널 전환', nl: 'Onderpaneel schakelen', pl: 'Przełącz dolny panel', pt: 'Alternar painel inferior',
    ro: 'Comută panoul inferior', ru: 'Переключить нижнюю панель', sl: 'Preklopi spodnji predal', sq: 'Ndërro panelin e poshtëm', sr: 'Prebaci donji panel',
    sv: 'Växla nedre panel', tr: 'Alt Paneli Aç/Kapat', uk: 'Перемкнути нижню панель', 'zh-Hans': '切换底部抽屉', 'zh-Hant': '切換底部抽屜',
  },
  'Toggle Inspector': {
    bg: 'Превключи инспектора', cs: 'Přepnout inspektor', de: 'Inspektor umschalten', el: 'Εναλλαγή επιθεωρητή', en: 'Toggle Inspector',
    es: 'Alternar inspector', fr: 'Basculer l’inspecteur', hr: 'Uključi/isključi inspektor', hu: 'Inspektor váltása', it: 'Attiva/disattiva ispettore',
    ja: 'インスペクタを切り替え', ko: '인스펙터 전환', nl: 'Inspector schakelen', pl: 'Przełącz inspektor', pt: 'Alternar inspetor',
    ro: 'Comută inspectorul', ru: 'Переключить инспектор', sl: 'Preklopi inšpektor', sq: 'Ndërro inspektorin', sr: 'Prebaci inspektor',
    sv: 'Växla inspektör', tr: 'Denetleyiciyi Aç/Kapat', uk: 'Перемкнути інспектор', 'zh-Hans': '切换检查器', 'zh-Hant': '切換檢查器',
  },
  'Next Changed Map': {
    bg: 'Следваща променена карта', cs: 'Další změněná mapa', de: 'Nächstes geändertes Kennfeld', el: 'Επόμενος αλλαγμένος χάρτης', en: 'Next Changed Map',
    es: 'Siguiente mapa modificado', fr: 'Carte modifiée suivante', hr: 'Sljedeća izmijenjena mapa', hu: 'Következő módosított térkép', it: 'Prossima mappa modificata',
    ja: '次の変更マップ', ko: '다음 변경된 맵', nl: 'Volgende gewijzigde map', pl: 'Następna zmieniona mapa', pt: 'Próximo mapa alterado',
    ro: 'Următoarea hartă modificată', ru: 'Следующая изменённая карта', sl: 'Naslednja spremenjena mapa', sq: 'Harta tjetër e ndryshuar', sr: 'Sledeća izmenjena mapa',
    sv: 'Nästa ändrade karta', tr: 'Sonraki Değişen Harita', uk: 'Наступна змінена карта', 'zh-Hans': '下一个已修改图谱', 'zh-Hant': '下一個已修改圖譜',
  },
  'Previous Changed Map': {
    bg: 'Предишна променена карта', cs: 'Předchozí změněná mapa', de: 'Vorheriges geändertes Kennfeld', el: 'Προηγούμενος αλλαγμένος χάρτης', en: 'Previous Changed Map',
    es: 'Mapa modificado anterior', fr: 'Carte modifiée précédente', hr: 'Prethodna izmijenjena mapa', hu: 'Előző módosított térkép', it: 'Mappa modificata precedente',
    ja: '前の変更マップ', ko: '이전 변경된 맵', nl: 'Vorige gewijzigde map', pl: 'Poprzednia zmieniona mapa', pt: 'Mapa alterado anterior',
    ro: 'Harta modificată anterioară', ru: 'Предыдущая изменённая карта', sl: 'Prejšnja spremenjena mapa', sq: 'Harta e mëparshme e ndryshuar', sr: 'Prethodna izmenjena mapa',
    sv: 'Föregående ändrade karta', tr: 'Önceki Değişen Harita', uk: 'Попередня змінена карта', 'zh-Hans': '上一个已修改图谱', 'zh-Hant': '上一個已修改圖譜',
  },
  'Fix Checksums': {
    bg: 'Коригирай контролните суми', cs: 'Opravit kontrolní součty', de: 'Prüfsummen korrigieren', el: 'Διόρθωση αθροισμάτων ελέγχου', en: 'Fix Checksums',
    es: 'Corregir sumas de control', fr: 'Corriger les sommes de contrôle', hr: 'Popravi kontrolne zbrojeve', hu: 'Ellenőrzőösszegek javítása', it: 'Correggi checksum',
    ja: 'チェックサムを修正', ko: '체크섬 수정', nl: 'Checksums herstellen', pl: 'Napraw sumy kontrolne', pt: 'Corrigir checksums',
    ro: 'Corectează sumele de control', ru: 'Исправить контрольные суммы', sl: 'Popravi kontrolne vsote', sq: 'Rregullo shumat e kontrollit', sr: 'Popravi kontrolne sume',
    sv: 'Åtgärda kontrollsummor', tr: 'Sağlama Toplamlarını Düzelt', uk: 'Виправити контрольні суми', 'zh-Hans': '修复校验和', 'zh-Hant': '修復校驗和',
  },
  'Quick Snapshot': {
    bg: 'Бърза снимка', cs: 'Rychlý snímek', de: 'Schnell-Schnappschuss', el: 'Γρήγορο στιγμιότυπο', en: 'Quick Snapshot',
    es: 'Instantánea rápida', fr: 'Instantané rapide', hr: 'Brza snimka', hu: 'Gyors pillanatkép', it: 'Istantanea rapida',
    ja: 'クイックスナップショット', ko: '빠른 스냅샷', nl: 'Snelle momentopname', pl: 'Szybka migawka', pt: 'Instantâneo rápido',
    ro: 'Instantaneu rapid', ru: 'Быстрый снимок', sl: 'Hitri posnetek', sq: 'Pamje e shpejtë', sr: 'Brzi snimak',
    sv: 'Snabb ögonblicksbild', tr: 'Hızlı Anlık Görüntü', uk: 'Швидкий знімок', 'zh-Hans': '快速快照', 'zh-Hant': '快速快照',
  },
  'Auto-Align Definition': {
    bg: 'Автоподравняване на дефиниция', cs: 'Automatické zarovnání definice', de: 'Definition automatisch ausrichten', el: 'Αυτόματη στοίχιση ορισμού', en: 'Auto-Align Definition',
    es: 'Autoalinear definición', fr: 'Alignement auto de la définition', hr: 'Automatski poravnaj definiciju', hu: 'Definíció automatikus igazítása', it: 'Allineamento automatico definizione',
    ja: '定義を自動整列', ko: '정의 자동 정렬', nl: 'Definitie automatisch uitlijnen', pl: 'Autowyrównanie definicji', pt: 'Alinhar definição automaticamente',
    ro: 'Auto-aliniere definiție', ru: 'Автовыравнивание определения', sl: 'Samodejno poravnaj definicijo', sq: 'Rreshto automatikisht definicionin', sr: 'Automatski poravnaj definiciju',
    sv: 'Autojustera definition', tr: 'Tanımı Otomatik Hizala', uk: 'Автовирівнювання визначення', 'zh-Hans': '自动对齐定义', 'zh-Hant': '自動對齊定義',
  },
  'Command Palette…': {
    bg: 'Палитра с команди…', cs: 'Paleta příkazů…', de: 'Befehlspalette…', el: 'Παλέτα εντολών…', en: 'Command Palette…',
    es: 'Paleta de comandos…', fr: 'Palette de commandes…', hr: 'Paleta naredbi…', hu: 'Parancspaletta…', it: 'Palette comandi…',
    ja: 'コマンドパレット…', ko: '명령 팔레트…', nl: 'Opdrachtenpalet…', pl: 'Paleta poleceń…', pt: 'Paleta de comandos…',
    ro: 'Paletă de comenzi…', ru: 'Палитра команд…', sl: 'Paleta ukazov…', sq: 'Paleta e komandave…', sr: 'Paleta komandi…',
    sv: 'Kommandopalett…', tr: 'Komut Paleti…', uk: 'Палітра команд…', 'zh-Hans': '命令面板…', 'zh-Hant': '命令面板…',
  },
  'Split Hi/Lo EPROMs': {
    bg: 'Раздели Hi/Lo EPROM', cs: 'Rozdělit Hi/Lo EPROM', de: 'Hi/Lo-EPROMs teilen', el: 'Διαχωρισμός Hi/Lo EPROM', en: 'Split Hi/Lo EPROMs',
    es: 'Dividir EPROMs Hi/Lo', fr: 'Séparer les EPROM Hi/Lo', hr: 'Podijeli Hi/Lo EPROM', hu: 'Hi/Lo EPROM felosztása', it: 'Dividi EPROM Hi/Lo',
    ja: 'Hi/Lo EPROMを分割', ko: 'Hi/Lo EPROM 분할', nl: 'Hi/Lo EPROMs splitsen', pl: 'Podziel EPROM Hi/Lo', pt: 'Dividir EPROMs Hi/Lo',
    ro: 'Împarte EPROM Hi/Lo', ru: 'Разделить Hi/Lo EPROM', sl: 'Razdeli Hi/Lo EPROM', sq: 'Ndaj EPROM Hi/Lo', sr: 'Podeli Hi/Lo EPROM',
    sv: 'Dela Hi/Lo-EPROM', tr: 'Hi/Lo EPROM’ları Böl', uk: 'Розділити Hi/Lo EPROM', 'zh-Hans': '拆分高低位 EPROM', 'zh-Hant': '拆分高低位 EPROM',
  },

  // Sidebar
  'Hex Editor': {
    bg: 'Hex редактор', cs: 'Hex editor', de: 'Hex-Editor', el: 'Επεξεργαστής Hex', en: 'Hex Editor',
    es: 'Editor Hex', fr: 'Éditeur Hex', hr: 'Hex uređivač', hu: 'Hex szerkesztő', it: 'Editor Hex',
    ja: 'Hexエディタ', ko: 'Hex 편집기', nl: 'Hex-editor', pl: 'Edytor Hex', pt: 'Editor Hex',
    ro: 'Editor Hex', ru: 'Hex-редактор', sl: 'Hex urejevalnik', sq: 'Redaktuesi Hex', sr: 'Hex uređivač',
    sv: 'Hex-editor', tr: 'Hex Düzenleyici', uk: 'Hex-редактор', 'zh-Hans': '十六进制编辑器', 'zh-Hant': '十六進位編輯器',
  },
  'Map Editor': {
    bg: 'Редактор на карти', cs: 'Editor map', de: 'Kennfeld-Editor', el: 'Επεξεργαστής χαρτών', en: 'Map Editor',
    es: 'Editor de mapas', fr: 'Éditeur de cartes', hr: 'Uređivač mapa', hu: 'Térképszerkesztő', it: 'Editor mappe',
    ja: 'マップエディタ', ko: '맵 편집기', nl: 'Map-editor', pl: 'Edytor map', pt: 'Editor de mapas',
    ro: 'Editor hărți', ru: 'Редактор карт', sl: 'Urejevalnik map', sq: 'Redaktuesi i hartave', sr: 'Uređivač mapa',
    sv: 'Karteditor', tr: 'Harita Düzenleyici', uk: 'Редактор карт', 'zh-Hans': '图谱编辑器', 'zh-Hant': '圖譜編輯器',
  },
  'Maps': {
    bg: 'Карти', cs: 'Mapy', de: 'Kennfelder', el: 'Χάρτες', en: 'Maps',
    es: 'Mapas', fr: 'Cartes', hr: 'Mape', hu: 'Térképek', it: 'Mappe',
    ja: 'マップ', ko: '맵', nl: 'Mappen', pl: 'Mapy', pt: 'Mapas',
    ro: 'Hărți', ru: 'Карты', sl: 'Mape', sq: 'Hartat', sr: 'Mape',
    sv: 'Kartor', tr: 'Haritalar', uk: 'Карти', 'zh-Hans': '图谱', 'zh-Hant': '圖譜',
  },
  'Diffs': {
    bg: 'Разлики', cs: 'Rozdíly', de: 'Änderungen', el: 'Διαφορές', en: 'Diffs',
    es: 'Diferencias', fr: 'Diffs', hr: 'Razlike', hu: 'Eltérések', it: 'Differenze',
    ja: '差分', ko: '차이점', nl: 'Verschillen', pl: 'Różnice', pt: 'Diferenças',
    ro: 'Diferențe', ru: 'Различия', sl: 'Razlike', sq: 'Ndryshimet', sr: 'Razlike',
    sv: 'Ändringar', tr: 'Farklar', uk: 'Відмінності', 'zh-Hans': '差异', 'zh-Hant': '差異',
  },
  'Detected': {
    bg: 'Открити', cs: 'Detekováno', de: 'Erkannt', el: 'Εντοπισμένα', en: 'Detected',
    es: 'Detectados', fr: 'Détectées', hr: 'Otkriveno', hu: 'Észlelt', it: 'Rilevate',
    ja: '検出済み', ko: '감지됨', nl: 'Gedetecteerd', pl: 'Wykryte', pt: 'Detectados',
    ro: 'Detectate', ru: 'Обнаружено', sl: 'Zaznano', sq: 'Zbuluar', sr: 'Otkriveno',
    sv: 'Upptäckta', tr: 'Algılanan', uk: 'Виявлено', 'zh-Hans': '已检测', 'zh-Hant': '已偵測',
  },
  'Markers': {
    bg: 'Маркери', cs: 'Značky', de: 'Lesezeichen', el: 'Δείκτες', en: 'Markers',
    es: 'Marcadores', fr: 'Repères', hr: 'Oznake', hu: 'Jelölők', it: 'Marcatori',
    ja: 'マーカー', ko: '마커', nl: 'Markeringen', pl: 'Znaczniki', pt: 'Marcadores',
    ro: 'Marcaje', ru: 'Метки', sl: 'Oznake', sq: 'Shënuesit', sr: 'Oznake',
    sv: 'Markörer', tr: 'İşaretçiler', uk: 'Мітки', 'zh-Hans': '标记', 'zh-Hant': '標記',
  },
  'Search maps...': {
    bg: 'Търси карти...', cs: 'Hledat mapy...', de: 'Kennfelder suchen...', el: 'Αναζήτηση χαρτών...', en: 'Search maps...',
    es: 'Buscar mapas...', fr: 'Rechercher des cartes...', hr: 'Pretraži mape...', hu: 'Térképek keresése...', it: 'Cerca mappe...',
    ja: 'マップを検索...', ko: '맵 검색...', nl: 'Mappen zoeken...', pl: 'Szukaj map...', pt: 'Pesquisar mapas...',
    ro: 'Caută hărți...', ru: 'Поиск карт...', sl: 'Išči mape...', sq: 'Kërko harta...', sr: 'Pretraži mape...',
    sv: 'Sök kartor...', tr: 'Harita ara...', uk: 'Пошук карт...', 'zh-Hans': '搜索图谱...', 'zh-Hant': '搜尋圖譜...',
  },
  'All': {
    bg: 'Всички', cs: 'Vše', de: 'Alle', el: 'Όλα', en: 'All',
    es: 'Todos', fr: 'Tout', hr: 'Sve', hu: 'Összes', it: 'Tutte',
    ja: 'すべて', ko: '전체', nl: 'Alle', pl: 'Wszystkie', pt: 'Todos',
    ro: 'Toate', ru: 'Все', sl: 'Vse', sq: 'Të gjitha', sr: 'Sve',
    sv: 'Alla', tr: 'Tümü', uk: 'Усі', 'zh-Hans': '全部', 'zh-Hant': '全部',
  },
  'Changed': {
    bg: 'Променени', cs: 'Změněné', de: 'Geändert', el: 'Αλλαγμένα', en: 'Changed',
    es: 'Modificados', fr: 'Modifiées', hr: 'Izmijenjeno', hu: 'Módosított', it: 'Modificate',
    ja: '変更済み', ko: '변경됨', nl: 'Gewijzigd', pl: 'Zmienione', pt: 'Alterados',
    ro: 'Modificate', ru: 'Изменённые', sl: 'Spremenjeno', sq: 'Ndryshuar', sr: 'Izmenjeno',
    sv: 'Ändrade', tr: 'Değişen', uk: 'Змінені', 'zh-Hans': '已修改', 'zh-Hant': '已修改',
  },
  'Favorites': {
    bg: 'Любими', cs: 'Oblíbené', de: 'Favoriten', el: 'Αγαπημένα', en: 'Favorites',
    es: 'Favoritos', fr: 'Favoris', hr: 'Favoriti', hu: 'Kedvencek', it: 'Preferiti',
    ja: 'お気に入り', ko: '즐겨찾기', nl: 'Favorieten', pl: 'Ulubione', pt: 'Favoritos',
    ro: 'Favorite', ru: 'Избранное', sl: 'Priljubljene', sq: 'Të preferuarat', sr: 'Omiljeno',
    sv: 'Favoriter', tr: 'Favoriler', uk: 'Обране', 'zh-Hans': '收藏', 'zh-Hant': '收藏',
  },
  'Outside of XDF': {
    bg: 'Извън XDF', cs: 'Mimo XDF', de: 'Außerhalb der XDF', el: 'Εκτός XDF', en: 'Outside of XDF',
    es: 'Fuera del XDF', fr: 'Hors du XDF', hr: 'Izvan XDF-a', hu: 'XDF-en kívül', it: 'Fuori da XDF',
    ja: 'XDF外', ko: 'XDF 외부', nl: 'Buiten XDF', pl: 'Poza XDF', pt: 'Fora do XDF',
    ro: 'În afara XDF', ru: 'Вне XDF', sl: 'Zunaj XDF', sq: 'Jashtë XDF', sr: 'Van XDF-a',
    sv: 'Utanför XDF', tr: 'XDF Dışında', uk: 'Поза XDF', 'zh-Hans': 'XDF 之外', 'zh-Hant': 'XDF 之外',
  },

  // Hex-Diff
  'Text': {
    bg: 'Текст', cs: 'Text', de: 'Text', el: 'Κείμενο', en: 'Text',
    es: 'Texto', fr: 'Texte', hr: 'Tekst', hu: 'Szöveg', it: 'Testo',
    ja: 'テキスト', ko: '텍스트', nl: 'Tekst', pl: 'Tekst', pt: 'Texto',
    ro: 'Text', ru: 'Текст', sl: 'Besedilo', sq: 'Tekst', sr: 'Tekst',
    sv: 'Text', tr: 'Metin', uk: 'Текст', 'zh-Hans': '文本', 'zh-Hant': '文字',
  },
  '2D': {
    bg: '2D', cs: '2D', de: '2D', el: '2D', en: '2D',
    es: '2D', fr: '2D', hr: '2D', hu: '2D', it: '2D',
    ja: '2D', ko: '2D', nl: '2D', pl: '2D', pt: '2D',
    ro: '2D', ru: '2D', sl: '2D', sq: '2D', sr: '2D',
    sv: '2D', tr: '2D', uk: '2D', 'zh-Hans': '2D', 'zh-Hant': '2D',
  },
  '3D': {
    bg: '3D', cs: '3D', de: '3D', el: '3D', en: '3D',
    es: '3D', fr: '3D', hr: '3D', hu: '3D', it: '3D',
    ja: '3D', ko: '3D', nl: '3D', pl: '3D', pt: '3D',
    ro: '3D', ru: '3D', sl: '3D', sq: '3D', sr: '3D',
    sv: '3D', tr: '3D', uk: '3D', 'zh-Hans': '3D', 'zh-Hant': '3D',
  },
  'Split': {
    bg: 'Разделен', cs: 'Rozdělený', de: 'Geteilt', el: 'Διαχωρισμένο', en: 'Split',
    es: 'Dividido', fr: 'Scindé', hr: 'Podijeljeno', hu: 'Osztott', it: 'Diviso',
    ja: '分割', ko: '분할', nl: 'Gesplitst', pl: 'Podzielony', pt: 'Dividido',
    ro: 'Împărțit', ru: 'Разделить', sl: 'Deljeno', sq: 'I ndarë', sr: 'Podeljeno',
    sv: 'Delad', tr: 'Bölünmüş', uk: 'Розділений', 'zh-Hans': '分屏', 'zh-Hant': '分割',
  },
  'Single': {
    bg: 'Единичен', cs: 'Jednoduchý', de: 'Einzeln', el: 'Μονό', en: 'Single',
    es: 'Simple', fr: 'Unique', hr: 'Jednostruko', hu: 'Egyszeres', it: 'Singolo',
    ja: '単一', ko: '단일', nl: 'Enkel', pl: 'Pojedynczy', pt: 'Simples',
    ro: 'Simplu', ru: 'Одиночный', sl: 'Enojni', sq: 'I vetë', sr: 'Pojedinačno',
    sv: 'Enkel', tr: 'Tekli', uk: 'Одинарний', 'zh-Hans': '单屏', 'zh-Hant': '單一',
  },
  'Bars': {
    bg: 'Ленти', cs: 'Sloupce', de: 'Balken', el: 'Ράβδοι', en: 'Bars',
    es: 'Barras', fr: 'Barres', hr: 'Trake', hu: 'Oszlopok', it: 'Barre',
    ja: 'バー', ko: '막대', nl: 'Staven', pl: 'Słupki', pt: 'Barras',
    ro: 'Bare', ru: 'Полосы', sl: 'Stolpci', sq: 'Shtylla', sr: 'Trake',
    sv: 'Staplar', tr: 'Çubuklar', uk: 'Стовпці', 'zh-Hans': '条形', 'zh-Hant': '長條',
  },
  '2D Heatmap': {
    bg: '2D топлинна карта', cs: '2D teplotní mapa', de: '2D-Heatmap', el: '2D χάρτης θερμότητας', en: '2D Heatmap',
    es: 'Mapa de calor 2D', fr: 'Carte thermique 2D', hr: '2D toplinska karta', hu: '2D hőtérkép', it: 'Mappa termica 2D',
    ja: '2Dヒートマップ', ko: '2D 히트맵', nl: '2D-heatmap', pl: 'Mapa cieplna 2D', pt: 'Mapa de calor 2D',
    ro: 'Hartă termică 2D', ru: '2D тепловая карта', sl: '2D toplotni zemljevid', sq: 'Hartë termike 2D', sr: '2D toplotna mapa',
    sv: '2D-värmekarta', tr: '2D Isı Haritası', uk: '2D теплова карта', 'zh-Hans': '2D 热力图', 'zh-Hant': '2D 熱力圖',
  },
  'Sync': {
    bg: 'Синхр.', cs: 'Synchr.', de: 'Sync', el: 'Συγχρ.', en: 'Sync',
    es: 'Sinc.', fr: 'Synchro', hr: 'Sinkr.', hu: 'Szinkr.', it: 'Sinc.',
    ja: '同期', ko: '동기화', nl: 'Sync', pl: 'Synchr.', pt: 'Sinc.',
    ro: 'Sinc.', ru: 'Синхр.', sl: 'Sinhr.', sq: 'Sink.', sr: 'Sinhr.',
    sv: 'Synk', tr: 'Eşitle', uk: 'Синхр.', 'zh-Hans': '同步', 'zh-Hant': '同步',
  },
  'Diffs Only': {
    bg: 'Само разлики', cs: 'Jen rozdíly', de: 'Nur Unterschiede', el: 'Μόνο διαφορές', en: 'Diffs Only',
    es: 'Solo diferencias', fr: 'Diffs uniquement', hr: 'Samo razlike', hu: 'Csak eltérések', it: 'Solo differenze',
    ja: '差分のみ', ko: '차이만 보기', nl: 'Alleen verschillen', pl: 'Tylko różnice', pt: 'Apenas diferenças',
    ro: 'Doar diferențe', ru: 'Только отличия', sl: 'Samo razlike', sq: 'Vetëm ndryshimet', sr: 'Samo razlike',
    sv: 'Endast skillnader', tr: 'Yalnızca Farklar', uk: 'Лише відмінності', 'zh-Hans': '仅差异', 'zh-Hant': '僅差異',
  },
  'Code': {
    bg: 'Код', cs: 'Kód', de: 'Code', el: 'Κώδικας', en: 'Code',
    es: 'Código', fr: 'Code', hr: 'Kôd', hu: 'Kód', it: 'Codice',
    ja: 'コード', ko: '코드', nl: 'Code', pl: 'Kod', pt: 'Código',
    ro: 'Cod', ru: 'Код', sl: 'Koda', sq: 'Kod', sr: 'Kod',
    sv: 'Kod', tr: 'Kod', uk: 'Код', 'zh-Hans': '代码', 'zh-Hant': '程式碼',
  },
  'Go To 0x...': {
    bg: 'Отиди на 0x...', cs: 'Přejít na 0x...', de: 'Gehe zu 0x...', el: 'Μετάβαση σε 0x...', en: 'Go To 0x...',
    es: 'Ir a 0x...', fr: 'Aller à 0x...', hr: 'Idi na 0x...', hu: 'Ugrás: 0x...', it: 'Vai a 0x...',
    ja: '0x...へ移動', ko: '0x...로 이동', nl: 'Ga naar 0x...', pl: 'Przejdź do 0x...', pt: 'Ir para 0x...',
    ro: 'Mergi la 0x...', ru: 'Перейти к 0x...', sl: 'Pojdi na 0x...', sq: 'Shko te 0x...', sr: 'Idi na 0x...',
    sv: 'Gå till 0x...', tr: '0x... Adresine Git', uk: 'Перейти до 0x...', 'zh-Hans': '跳转到 0x...', 'zh-Hant': '跳轉到 0x...',
  },
  'Rescan': {
    bg: 'Сканирай отново', cs: 'Znovu prohledat', de: 'Neu scannen', el: 'Επανασάρωση', en: 'Rescan',
    es: 'Reescanear', fr: 'Rescanner', hr: 'Ponovo skeniraj', hu: 'Újravizsgálat', it: 'Riscansiona',
    ja: '再スキャン', ko: '다시 스캔', nl: 'Opnieuw scannen', pl: 'Skanuj ponownie', pt: 'Reescanear',
    ro: 'Rescanează', ru: 'Пересканировать', sl: 'Ponovno skeniraj', sq: 'Riskano', sr: 'Ponovo skeniraj',
    sv: 'Skanna igen', tr: 'Yeniden Tara', uk: 'Пересканувати', 'zh-Hans': '重新扫描', 'zh-Hant': '重新掃描',
  },
  'Restore': {
    bg: 'Възстанови', cs: 'Obnovit', de: 'Wiederherstellen', el: 'Επαναφορά', en: 'Restore',
    es: 'Restaurar', fr: 'Restaurer', hr: 'Vrati', hu: 'Visszaállítás', it: 'Ripristina',
    ja: '復元', ko: '복원', nl: 'Herstellen', pl: 'Przywróć', pt: 'Restaurar',
    ro: 'Restaurează', ru: 'Восстановить', sl: 'Obnovi', sq: 'Rikthe', sr: 'Vrati',
    sv: 'Återställ', tr: 'Geri Yükle', uk: 'Відновити', 'zh-Hans': '还原', 'zh-Hant': '還原',
  },
  'Auto-Cols': {
    bg: 'Авто-колони', cs: 'Auto-sloupce', de: 'Auto-Spalten', el: 'Αυτόμ. στήλες', en: 'Auto-Cols',
    es: 'Auto-Cols', fr: 'Colonnes auto', hr: 'Auto-stupci', hu: 'Auto-oszlop', it: 'Colonne auto',
    ja: '列幅自動', ko: '자동 열', nl: 'Auto-kol.', pl: 'Auto-kolumny', pt: 'Auto-colunas',
    ro: 'Auto-col.', ru: 'Авто-столбцы', sl: 'Samod. stolpci', sq: 'Auto-kol.', sr: 'Auto-kolone',
    sv: 'Auto-kol.', tr: 'Oto-Sütun', uk: 'Авто-стовпці', 'zh-Hans': '自动列数', 'zh-Hant': '自動欄數',
  },
  'Map from Selection…': {
    bg: 'Карта от селекцията…', cs: 'Mapa z výběru…', de: 'Kennfeld aus Auswahl…', el: 'Χάρτης από επιλογή…', en: 'Map from Selection…',
    es: 'Mapa desde selección…', fr: 'Carte depuis la sélection…', hr: 'Mapa iz odabira…', hu: 'Térkép a kijelölésből…', it: 'Mappa dalla selezione…',
    ja: '選択範囲からマップ作成…', ko: '선택에서 맵 생성…', nl: 'Map uit selectie…', pl: 'Mapa z zaznaczenia…', pt: 'Mapa da seleção…',
    ro: 'Hartă din selecție…', ru: 'Карта из выделения…', sl: 'Mapa iz izbire…', sq: 'Hartë nga përzgjedhja…', sr: 'Mapa iz izbora…',
    sv: 'Karta från markering…', tr: 'Seçimden Harita Oluştur…', uk: 'Карта з виділення…', 'zh-Hans': '从选区创建图谱…', 'zh-Hant': '從選區建立圖譜…',
  },
  'Edit…': {
    bg: 'Редактирай…', cs: 'Upravit…', de: 'Bearbeiten…', el: 'Επεξεργασία…', en: 'Edit…',
    es: 'Editar…', fr: 'Modifier…', hr: 'Uredi…', hu: 'Szerkesztés…', it: 'Modifica…',
    ja: '編集…', ko: '편집…', nl: 'Bewerken…', pl: 'Edytuj…', pt: 'Editar…',
    ro: 'Editează…', ru: 'Изменить…', sl: 'Uredi…', sq: 'Redakto…', sr: 'Uredi…',
    sv: 'Redigera…', tr: 'Düzenle…', uk: 'Редагувати…', 'zh-Hans': '编辑…', 'zh-Hant': '編輯…',
  },
  'Copy Hex': {
    bg: 'Копирай Hex', cs: 'Kopírovat Hex', de: 'Hex kopieren', el: 'Αντιγραφή Hex', en: 'Copy Hex',
    es: 'Copiar Hex', fr: 'Copier Hex', hr: 'Kopiraj Hex', hu: 'Hex másolása', it: 'Copia Hex',
    ja: 'Hexをコピー', ko: 'Hex 복사', nl: 'Hex kopiëren', pl: 'Kopiuj Hex', pt: 'Copiar Hex',
    ro: 'Copiază Hex', ru: 'Копировать Hex', sl: 'Kopiraj Hex', sq: 'Kopjo Hex', sr: 'Kopiraj Hex',
    sv: 'Kopiera Hex', tr: 'Hex Kopyala', uk: 'Копіювати Hex', 'zh-Hans': '复制十六进制', 'zh-Hant': '複製十六進位',
  },
  'Twins': {
    bg: 'Близнаци', cs: 'Dvojčata', de: 'Zwillinge', el: 'Δίδυμα', en: 'Twins',
    es: 'Gemelos', fr: 'Jumeaux', hr: 'Blizanci', hu: 'Ikrek', it: 'Gemelli',
    ja: 'ツイン', ko: '트윈', nl: 'Tweelingen', pl: 'Bliźniaki', pt: 'Gêmeos',
    ro: 'Gemeni', ru: 'Двойники', sl: 'Dvojčki', sq: 'Binjakë', sr: 'Blizanci',
    sv: 'Tvillingar', tr: 'İkizler', uk: 'Двійники', 'zh-Hans': '镜像图', 'zh-Hant': '鏡像圖',
  },
  'XDF Map / Detected': {
    bg: 'XDF карта / Открита', cs: 'XDF mapa / Detekováno', de: 'XDF-Kennfeld / Erkannt', el: 'Χάρτης XDF / Εντοπίστηκε', en: 'XDF Map / Detected',
    es: 'Mapa XDF / Detectado', fr: 'Carte XDF / Détectée', hr: 'XDF mapa / Otkriveno', hu: 'XDF térkép / Észlelt', it: 'Mappa XDF / Rilevata',
    ja: 'XDFマップ / 検出済み', ko: 'XDF 맵 / 감지됨', nl: 'XDF-map / Gedetecteerd', pl: 'Mapa XDF / Wykryta', pt: 'Mapa XDF / Detectado',
    ro: 'Hartă XDF / Detectată', ru: 'Карта XDF / Обнаружена', sl: 'XDF mapa / Zaznano', sq: 'Hartë XDF / Zbuluar', sr: 'XDF mapa / Otkriveno',
    sv: 'XDF-karta / Upptäckt', tr: 'XDF Haritası / Algılanan', uk: 'Карта XDF / Виявлена', 'zh-Hans': 'XDF 图谱 / 已检测', 'zh-Hant': 'XDF 圖譜 / 已偵測',
  },

  // Map Editor
  'Set': {
    bg: 'Задай', cs: 'Nastavit', de: 'Setzen', el: 'Ορισμός', en: 'Set',
    es: 'Fijar', fr: 'Définir', hr: 'Postavi', hu: 'Beállítás', it: 'Imposta',
    ja: '設定', ko: '설정', nl: 'Instellen', pl: 'Ustaw', pt: 'Definir',
    ro: 'Setează', ru: 'Задать', sl: 'Nastavi', sq: 'Vendos', sr: 'Postavi',
    sv: 'Sätt', tr: 'Ayarla', uk: 'Задати', 'zh-Hans': '设置', 'zh-Hant': '設定',
  },
  'Original': {
    bg: 'Оригинал', cs: 'Originál', de: 'Original', el: 'Αρχικό', en: 'Original',
    es: 'Original', fr: 'Origine', hr: 'Original', hu: 'Eredeti', it: 'Originale',
    ja: 'オリジナル', ko: '원본', nl: 'Origineel', pl: 'Oryginał', pt: 'Original',
    ro: 'Original', ru: 'Оригинал', sl: 'Izvirnik', sq: 'Origjinal', sr: 'Original',
    sv: 'Original', tr: 'Orijinal', uk: 'Оригінал', 'zh-Hans': '原始值', 'zh-Hant': '原始值',
  },
  'Smooth': {
    bg: 'Изглади', cs: 'Vyhladit', de: 'Glätten', el: 'Εξομάλυνση', en: 'Smooth',
    es: 'Suavizar', fr: 'Lisser', hr: 'Zagladiti', hu: 'Simítás', it: 'Leviga',
    ja: '平滑化', ko: '부드럽게', nl: 'Vloeiend', pl: 'Wygładź', pt: 'Suavizar',
    ro: 'Netezește', ru: 'Сгладить', sl: 'Zgladi', sq: 'Lëmo', sr: 'Ugladi',
    sv: 'Jämna ut', tr: 'Yumuşat', uk: 'Згладити', 'zh-Hans': '平滑', 'zh-Hant': '平滑',
  },
  'Interp': {
    bg: 'Интерп.', cs: 'Interp.', de: 'Interp.', el: 'Παρεμβ.', en: 'Interp',
    es: 'Interp.', fr: 'Interp.', hr: 'Interp.', hu: 'Interp.', it: 'Interp.',
    ja: '補間', ko: '보간', nl: 'Interp.', pl: 'Interp.', pt: 'Interp.',
    ro: 'Interp.', ru: 'Интерп.', sl: 'Interp.', sq: 'Interp.', sr: 'Interp.',
    sv: 'Interp.', tr: 'İnterp.', uk: 'Інтерп.', 'zh-Hans': '插值', 'zh-Hant': '插值',
  },
  'Fill': {
    bg: 'Запълни', cs: 'Vyplnit', de: 'Füllen', el: 'Γέμισμα', en: 'Fill',
    es: 'Rellenar', fr: 'Remplir', hr: 'Ispuni', hu: 'Kitöltés', it: 'Riempi',
    ja: '塗りつぶし', ko: '채우기', nl: 'Vullen', pl: 'Wypełnij', pt: 'Preencher',
    ro: 'Umple', ru: 'Заполнить', sl: 'Zapolni', sq: 'Mbush', sr: 'Popuni',
    sv: 'Fyll', tr: 'Doldur', uk: 'Заповнити', 'zh-Hans': '填充', 'zh-Hant': '填充',
  },
  'Rescale': {
    bg: 'Премащабирай', cs: 'Přeškálovat', de: 'Skalieren', el: 'Κλιμάκωση', en: 'Rescale',
    es: 'Reescalar', fr: 'Recalibrer', hr: 'Skaliraj', hu: 'Átméretezés', it: 'Riscala',
    ja: '再スケール', ko: '재조정', nl: 'Herschalen', pl: 'Przeskaluj', pt: 'Redimensionar',
    ro: 'Rescalează', ru: 'Масштаб', sl: 'Prerazporedi', sq: 'Rishkallëzo', sr: 'Skaliraj',
    sv: 'Skala om', tr: 'Yeniden Ölçekle', uk: 'Масштабувати', 'zh-Hans': '重缩放', 'zh-Hant': '重縮放',
  },
  'Axes': {
    bg: 'Оси', cs: 'Osy', de: 'Achsen', el: 'Άξονες', en: 'Axes',
    es: 'Ejes', fr: 'Axes', hr: 'Osi', hu: 'Tengelyek', it: 'Assi',
    ja: '軸', ko: '축', nl: 'Assen', pl: 'Osie', pt: 'Eixos',
    ro: 'Axe', ru: 'Оси', sl: 'Osi', sq: 'Boshtet', sr: 'Ose',
    sv: 'Axlar', tr: 'Eksenler', uk: 'Осі', 'zh-Hans': '坐标轴', 'zh-Hant': '座標軸',
  },
  'Actions': {
    bg: 'Действия', cs: 'Akce', de: 'Aktionen', el: 'Ενέργειες', en: 'Actions',
    es: 'Acciones', fr: 'Actions', hr: 'Radnje', hu: 'Műveletek', it: 'Azioni',
    ja: 'アクション', ko: '작업', nl: 'Acties', pl: 'Akcje', pt: 'Ações',
    ro: 'Acțiuni', ru: 'Действия', sl: 'Dejanja', sq: 'Veprime', sr: 'Radnje',
    sv: 'Åtgärder', tr: 'İşlemler', uk: 'Дії', 'zh-Hans': '操作', 'zh-Hant': '操作',
  },
  'Limits': {
    bg: 'Граници', cs: 'Limity', de: 'Grenzwerte', el: 'Όρια', en: 'Limits',
    es: 'Límites', fr: 'Limites', hr: 'Granice', hu: 'Határértékek', it: 'Limiti',
    ja: '制限値', ko: '제한값', nl: 'Limieten', pl: 'Limity', pt: 'Limites',
    ro: 'Limite', ru: 'Лимиты', sl: 'Omejitve', sq: 'Kufijtë', sr: 'Granice',
    sv: 'Gränser', tr: 'Limitler', uk: 'Ліміти', 'zh-Hans': '限值', 'zh-Hant': '限值',
  },
  'Pin': {
    bg: 'Закачи', cs: 'Připnout', de: 'Anheften', el: 'Καρφίτσωμα', en: 'Pin',
    es: 'Fijar', fr: 'Épingler', hr: 'Prikvači', hu: 'Rögzítés', it: 'Fissa',
    ja: 'ピン留め', ko: '고정', nl: 'Vastzetten', pl: 'Przypnij', pt: 'Fixar',
    ro: 'Fixează', ru: 'Закрепить', sl: 'Pripni', sq: 'Fikso', sr: 'Zakači',
    sv: 'Fäst', tr: 'Sabitle', uk: 'Закріпити', 'zh-Hans': '固定', 'zh-Hant': '釘選',
  },
  'Copy From': {
    bg: 'Копирай от', cs: 'Kopírovat z', de: 'Kopieren von', el: 'Αντιγραφή από', en: 'Copy From',
    es: 'Copiar de', fr: 'Copier depuis', hr: 'Kopiraj iz', hu: 'Másolás innen', it: 'Copia da',
    ja: 'コピー元', ko: '복사 원본', nl: 'Kopiëren van', pl: 'Kopiuj z', pt: 'Copiar de',
    ro: 'Copiază din', ru: 'Копировать из', sl: 'Kopiraj iz', sq: 'Kopjo nga', sr: 'Kopiraj iz',
    sv: 'Kopiera från', tr: 'Şuradan Kopyala', uk: 'Копіювати з', 'zh-Hans': '复制自', 'zh-Hant': '複製自',
  },
  'Lock': {
    bg: 'Заключи', cs: 'Zamknout', de: 'Sperren', el: 'Κλείδωμα', en: 'Lock',
    es: 'Bloquear', fr: 'Verrouiller', hr: 'Zaključaj', hu: 'Zárolás', it: 'Blocca',
    ja: 'ロック', ko: '잠금', nl: 'Vergrendelen', pl: 'Zablokuj', pt: 'Bloquear',
    ro: 'Blochează', ru: 'Заблокировать', sl: 'Zakleni', sq: 'Kyç', sr: 'Zaključaj',
    sv: 'Lås', tr: 'Kilitle', uk: 'Заблокувати', 'zh-Hans': '锁定', 'zh-Hant': '鎖定',
  },
  'Edit XDF': {
    bg: 'Редактирай XDF', cs: 'Upravit XDF', de: 'XDF bearbeiten', el: 'Επεξεργασία XDF', en: 'Edit XDF',
    es: 'Editar XDF', fr: 'Modifier XDF', hr: 'Uredi XDF', hu: 'XDF szerkesztése', it: 'Modifica XDF',
    ja: 'XDFを編集', ko: 'XDF 편집', nl: 'XDF bewerken', pl: 'Edytuj XDF', pt: 'Editar XDF',
    ro: 'Editează XDF', ru: 'Редактировать XDF', sl: 'Uredi XDF', sq: 'Redakto XDF', sr: 'Uredi XDF',
    sv: 'Redigera XDF', tr: 'XDF Düzenle', uk: 'Редагувати XDF', 'zh-Hans': '编辑 XDF', 'zh-Hant': '編輯 XDF',
  },
  'Hex': {
    bg: 'Hex', cs: 'Hex', de: 'Hex', el: 'Hex', en: 'Hex',
    es: 'Hex', fr: 'Hex', hr: 'Hex', hu: 'Hex', it: 'Hex',
    ja: 'Hex', ko: 'Hex', nl: 'Hex', pl: 'Hex', pt: 'Hex',
    ro: 'Hex', ru: 'Hex', sl: 'Hex', sq: 'Hex', sr: 'Hex',
    sv: 'Hex', tr: 'Hex', uk: 'Hex', 'zh-Hans': 'Hex', 'zh-Hant': 'Hex',
  },
  'Reset': {
    bg: 'Нулиране', cs: 'Obnovit', de: 'Zurücksetzen', el: 'Επαναφορά', en: 'Reset',
    es: 'Restablecer', fr: 'Réinitialiser', hr: 'Poništi', hu: 'Visszaállítás', it: 'Ripristina',
    ja: 'リセット', ko: '초기화', nl: 'Herstellen', pl: 'Resetuj', pt: 'Redefinir',
    ro: 'Resetează', ru: 'Сбросить', sl: 'Ponastavi', sq: 'Rivendos', sr: 'Resetuj',
    sv: 'Återställ', tr: 'Sıfırla', uk: 'Скинути', 'zh-Hans': '重置', 'zh-Hant': '重設',
  },
  '3D Surface': {
    bg: '3D повърхност', cs: '3D povrch', de: '3D-Oberfläche', el: '3D επιφάνεια', en: '3D Surface',
    es: 'Superficie 3D', fr: 'Surface 3D', hr: '3D površina', hu: '3D felület', it: 'Superficie 3D',
    ja: '3Dサーフェス', ko: '3D 표면', nl: '3D-oppervlak', pl: 'Powierzchnia 3D', pt: 'Superfície 3D',
    ro: 'Suprafață 3D', ru: '3D-поверхность', sl: '3D površina', sq: 'Sipërfaqe 3D', sr: '3D površina',
    sv: '3D-yta', tr: '3D Yüzey', uk: '3D-поверхня', 'zh-Hans': '3D 曲面', 'zh-Hant': '3D 曲面',
  },
  '2D Curves': {
    bg: '2D криви', cs: '2D křivky', de: '2D-Kurven', el: '2D καμπύλες', en: '2D Curves',
    es: 'Curvas 2D', fr: 'Courbes 2D', hr: '2D krivulje', hu: '2D görbék', it: 'Curve 2D',
    ja: '2Dカーブ', ko: '2D 곡선', nl: '2D-curven', pl: 'Krzywe 2D', pt: 'Curvas 2D',
    ro: 'Curbe 2D', ru: '2D-кривые', sl: '2D krivulje', sq: 'Kurba 2D', sr: '2D krive',
    sv: '2D-kurvor', tr: '2D Eğriler', uk: '2D-криві', 'zh-Hans': '2D 曲线', 'zh-Hant': '2D 曲線',
  },
  'Points': {
    bg: 'Точки', cs: 'Body', de: 'Punkte', el: 'Σημεία', en: 'Points',
    es: 'Puntos', fr: 'Points', hr: 'Točke', hu: 'Pontok', it: 'Punti',
    ja: 'ポイント', ko: '포인트', nl: 'Punten', pl: 'Punkty', pt: 'Pontos',
    ro: 'Puncte', ru: 'Точки', sl: 'Točke', sq: 'Pika', sr: 'Tačke',
    sv: 'Punkter', tr: 'Noktalar', uk: 'Точки', 'zh-Hans': '数据点', 'zh-Hant': '數據點',
  },
  'Curves': {
    bg: 'Криви', cs: 'Křivky', de: 'Kurven', el: 'Καμπύλες', en: 'Curves',
    es: 'Curvas', fr: 'Courbes', hr: 'Krivulje', hu: 'Görbék', it: 'Curve',
    ja: 'カーブ', ko: '곡선', nl: 'Curven', pl: 'Krzywe', pt: 'Curvas',
    ro: 'Curbe', ru: 'Кривые', sl: 'Krivulje', sq: 'Kurba', sr: 'Krive',
    sv: 'Kurvor', tr: 'Eğriler', uk: 'Криві', 'zh-Hans': '曲线', 'zh-Hant': '曲線',
  },
  'Slices': {
    bg: 'Срезове', cs: 'Řezy', de: 'Schnitte', el: 'Τομές', en: 'Slices',
    es: 'Cortes', fr: 'Coupes', hr: 'Presjeci', hu: 'Szeletek', it: 'Sezioni',
    ja: 'スライス', ko: '슬라이스', nl: 'Sneden', pl: 'Przekroje', pt: 'Fatias',
    ro: 'Secțiuni', ru: 'Срезы', sl: 'Prerezi', sq: 'Prerje', sr: 'Preseci',
    sv: 'Snitt', tr: 'Kesitler', uk: 'Зрізи', 'zh-Hans': '切片', 'zh-Hant': '切片',
  },
  'Comparison': {
    bg: 'Сравнение', cs: 'Porovnání', de: 'Vergleich', el: 'Σύγκριση', en: 'Comparison',
    es: 'Comparación', fr: 'Comparaison', hr: 'Usporedba', hu: 'Összehasonlítás', it: 'Confronto',
    ja: '比較', ko: '비교', nl: 'Vergelijking', pl: 'Porównanie', pt: 'Comparação',
    ro: 'Comparație', ru: 'Сравнение', sl: 'Primerjava', sq: 'Krahasim', sr: 'Poređenje',
    sv: 'Jämförelse', tr: 'Karşılaştırma', uk: 'Порівняння', 'zh-Hans': '对比', 'zh-Hant': '對比',
  },
  'Mirror Edits': {
    bg: 'Огледални редакции', cs: 'Zrcadlit úpravy', de: 'Änderungen spiegeln', el: 'Κατοπτρισμός αλλαγών', en: 'Mirror Edits',
    es: 'Reflejar ediciones', fr: 'Miroir des modifications', hr: 'Zrcali izmjene', hu: 'Szerkesztések tükrözése', it: 'Rispecchia modifiche',
    ja: '編集をミラー', ko: '편집 미러링', nl: 'Bewerkingen spiegelen', pl: 'Odbij edycje', pt: 'Espelhar edições',
    ro: 'Oglindește editările', ru: 'Зеркалить правки', sl: 'Zrcali urejanja', sq: 'Pasqyro redaktimet', sr: 'Preslikaj izmene',
    sv: 'Spegla ändringar', tr: 'Düzenlemeleri Yansıt', uk: 'Дзеркалити правки', 'zh-Hans': '镜像编辑', 'zh-Hant': '鏡像編輯',
  },

  // Overview
  'Calibration Overview': {
    bg: 'Преглед на калибрацията', cs: 'Přehled kalibrace', de: 'Kalibrierungsübersicht', el: 'Επισκόπηση βαθμονόμησης', en: 'Calibration Overview',
    es: 'Resumen de calibración', fr: 'Aperçu de calibration', hr: 'Pregled kalibracije', hu: 'Kalibrációs áttekintés', it: 'Panoramica calibrazione',
    ja: 'キャリブレーション概要', ko: '캘리브레이션 개요', nl: 'Kalibratie-overzicht', pl: 'Przegląd kalibracji', pt: 'Visão geral da calibração',
    ro: 'Prezentare calibrare', ru: 'Обзор калибровки', sl: 'Pregled kalibracije', sq: 'Përmbledhja e kalibrimit', sr: 'Pregled kalibracije',
    sv: 'Kalibreringsöversikt', tr: 'Kalibrasyon Genel Bakış', uk: 'Огляд калібрування', 'zh-Hans': '标定概览', 'zh-Hant': '標定概覽',
  },
  'XDF Maps': {
    bg: 'XDF карти', cs: 'XDF mapy', de: 'XDF-Kennfelder', el: 'Χάρτες XDF', en: 'XDF Maps',
    es: 'Mapas XDF', fr: 'Cartes XDF', hr: 'XDF mape', hu: 'XDF térképek', it: 'Mappe XDF',
    ja: 'XDFマップ', ko: 'XDF 맵', nl: 'XDF-mappen', pl: 'Mapy XDF', pt: 'Mapas XDF',
    ro: 'Hărți XDF', ru: 'Карты XDF', sl: 'XDF mape', sq: 'Hartat XDF', sr: 'XDF mape',
    sv: 'XDF-kartor', tr: 'XDF Haritaları', uk: 'Карти XDF', 'zh-Hans': 'XDF 图谱', 'zh-Hant': 'XDF 圖譜',
  },
  'BIN Size': {
    bg: 'Размер на BIN', cs: 'Velikost BIN', de: 'BIN-Größe', el: 'Μέγεθος BIN', en: 'BIN Size',
    es: 'Tamaño BIN', fr: 'Taille BIN', hr: 'Veličina BIN-a', hu: 'BIN méret', it: 'Dimensione BIN',
    ja: 'BINサイズ', ko: 'BIN 크기', nl: 'BIN-grootte', pl: 'Rozmiar BIN', pt: 'Tamanho do BIN',
    ro: 'Dimensiune BIN', ru: 'Размер BIN', sl: 'Velikost BIN', sq: 'Madhësia e BIN', sr: 'Veličina BIN-a',
    sv: 'BIN-storlek', tr: 'BIN Boyutu', uk: 'Розмір BIN', 'zh-Hans': 'BIN 大小', 'zh-Hant': 'BIN 大小',
  },
  'Changed Maps': {
    bg: 'Променени карти', cs: 'Změněné mapy', de: 'Geänderte Kennfelder', el: 'Αλλαγμένοι χάρτες', en: 'Changed Maps',
    es: 'Mapas modificados', fr: 'Cartes modifiées', hr: 'Izmijenjene mape', hu: 'Módosított térképek', it: 'Mappe modificate',
    ja: '変更されたマップ', ko: '변경된 맵', nl: 'Gewijzigde mappen', pl: 'Zmienione mapy', pt: 'Mapas alterados',
    ro: 'Hărți modificate', ru: 'Изменённые карты', sl: 'Spremenjene mape', sq: 'Hartat e ndryshuara', sr: 'Izmenjene mape',
    sv: 'Ändrade kartor', tr: 'Değişen Haritalar', uk: 'Змінені карти', 'zh-Hans': '已修改图谱', 'zh-Hant': '已修改圖譜',
  },
  'Checksum Status': {
    bg: 'Статус на контролната сума', cs: 'Stav kontrolního součtu', de: 'Prüfsummenstatus', el: 'Κατάσταση αθροίσματος ελέγχου', en: 'Checksum Status',
    es: 'Estado de suma de control', fr: 'État de somme de contrôle', hr: 'Status kontrolnog zbroja', hu: 'Ellenőrzőösszeg állapota', it: 'Stato checksum',
    ja: 'チェックサム状態', ko: '체크섬 상태', nl: 'Checksumstatus', pl: 'Status sumy kontrolnej', pt: 'Status do checksum',
    ro: 'Stare sumă de control', ru: 'Статус контрольной суммы', sl: 'Stanje kontrolne vsote', sq: 'Statusi i shumës së kontrollit', sr: 'Status kontrolne sume',
    sv: 'Kontrollsummestatus', tr: 'Sağlama Toplamı Durumu', uk: 'Статус контрольної суми', 'zh-Hans': '校验和状态', 'zh-Hant': '校驗和狀態',
  },
  'ECU Identity & Signatures': {
    bg: 'Идентичност и подписи на ECU', cs: 'Identita a podpisy ECU', de: 'ECU-Identität & Signaturen', el: 'Ταυτότητα & υπογραφές ECU', en: 'ECU Identity & Signatures',
    es: 'Identidad y firmas de ECU', fr: 'Identité et signatures ECU', hr: 'ECU identitet i potpisi', hu: 'ECU azonosító és aláírások', it: 'Identità e firme ECU',
    ja: 'ECU識別と署名', ko: 'ECU 식별 및 서명', nl: 'ECU-identiteit & handtekeningen', pl: 'Identyfikacja i sygnatury ECU', pt: 'Identidade e assinaturas ECU',
    ro: 'Identitate și semnături ECU', ru: 'Идентификация и сигнатуры ECU', sl: 'Identiteta in podpisi ECU', sq: 'Identiteti dhe nënshkrimet e ECU', sr: 'ECU identitet i potpisi',
    sv: 'ECU-identitet & signaturer', tr: 'ECU Kimliği ve İmzalar', uk: 'Ідентифікація та сигнатури ECU', 'zh-Hans': 'ECU 识别与签名', 'zh-Hant': 'ECU 識別與簽名',
  },
  'Quick Workbenches': {
    bg: 'Бързи работни модули', cs: 'Rychlé pracovní nástroje', de: 'Schnell-Werkbänke', el: 'Γρήγοροι πάγκοι εργασίας', en: 'Quick Workbenches',
    es: 'Mesas de trabajo rápidas', fr: 'Ateliers rapides', hr: 'Brzi radni moduli', hu: 'Gyors munkapadok', it: 'Banchi rapidi',
    ja: 'クイックワークベンチ', ko: '빠른 워크벤치', nl: 'Snelle werkbanken', pl: 'Szybkie moduły', pt: 'Bancadas rápidas',
    ro: 'Ateliere rapide', ru: 'Быстрые инструменты', sl: 'Hitre delovne mize', sq: 'Mjete të shpejta', sr: 'Brzi radni alati',
    sv: 'Snabbverktyg', tr: 'Hızlı Çalışma Tezgâhları', uk: 'Швидкі інструменти', 'zh-Hans': '快捷工作台', 'zh-Hant': '快捷工作台',
  },
  'Modified Calibration Maps': {
    bg: 'Променени калибрационни карти', cs: 'Změněné kalibrační mapy', de: 'Geänderte Kalibrierungskennfelder', el: 'Τροποποιημένοι χάρτες βαθμονόμησης', en: 'Modified Calibration Maps',
    es: 'Mapas de calibración modificados', fr: 'Cartes de calibration modifiées', hr: 'Izmijenjene kalibracijske mape', hu: 'Módosított kalibrációs térképek', it: 'Mappe di calibrazione modificate',
    ja: '変更されたキャリブレーションマップ', ko: '수정된 캘리브레이션 맵', nl: 'Gewijzigde kalibratiemappen', pl: 'Zmodyfikowane mapy kalibracyjne', pt: 'Mapas de calibração modificados',
    ro: 'Hărți de calibrare modificate', ru: 'Изменённые карты калибровки', sl: 'Spremenjene kalibracijske mape', sq: 'Hartat e kalibrimit të ndryshuara', sr: 'Izmenjene kalibracione mape',
    sv: 'Ändrade kalibreringskartor', tr: 'Değiştirilen Kalibrasyon Haritaları', uk: 'Змінені карти калібрування', 'zh-Hans': '已修改标定图谱', 'zh-Hant': '已修改標定圖譜',
  },
  'Outside-XDF Changes': {
    bg: 'Промени извън XDF', cs: 'Změny mimo XDF', de: 'Änderungen außerhalb der XDF', el: 'Αλλαγές εκτός XDF', en: 'Outside-XDF Changes',
    es: 'Cambios fuera de XDF', fr: 'Modifications hors XDF', hr: 'Izmjene izvan XDF-a', hu: 'XDF-en kívüli módosítások', it: 'Modifiche fuori XDF',
    ja: 'XDF外の変更', ko: 'XDF 외부 변경사항', nl: 'Wijzigingen buiten XDF', pl: 'Zmiany poza XDF', pt: 'Alterações fora do XDF',
    ro: 'Modificări în afara XDF', ru: 'Изменения вне XDF', sl: 'Spremembe zunaj XDF', sq: 'Ndryshime jashtë XDF', sr: 'Izmene van XDF-a',
    sv: 'Ändringar utanför XDF', tr: 'XDF Dışı Değişiklikler', uk: 'Зміни поза XDF', 'zh-Hans': 'XDF 之外的更改', 'zh-Hant': 'XDF 之外的變更',
  },
  'TXT Changelog': {
    bg: 'TXT списък с промени', cs: 'TXT seznam změn', de: 'TXT-Änderungsliste', el: 'Αρχείο αλλαγών TXT', en: 'TXT Changelog',
    es: 'Registro TXT', fr: 'Journal TXT', hr: 'TXT popis izmjena', hu: 'TXT változásnapló', it: 'Changelog TXT',
    ja: 'TXT変更履歴', ko: 'TXT 변경 로그', nl: 'TXT-wijzigingslog', pl: 'Lista zmian TXT', pt: 'Log de alterações TXT',
    ro: 'Jurnal TXT', ru: 'TXT-список изменений', sl: 'TXT dnevnik sprememb', sq: 'Lista TXT e ndryshimeve', sr: 'TXT lista izmena',
    sv: 'TXT-ändringslogg', tr: 'TXT Değişiklik Günlüğü', uk: 'TXT-список змін', 'zh-Hans': 'TXT 变更日志', 'zh-Hant': 'TXT 變更日誌',
  },
  'HTML Report': {
    bg: 'HTML отчет', cs: 'HTML zpráva', de: 'HTML-Bericht', el: 'Αναφορά HTML', en: 'HTML Report',
    es: 'Informe HTML', fr: 'Rapport HTML', hr: 'HTML izvješće', hu: 'HTML jelentés', it: 'Report HTML',
    ja: 'HTMLレポート', ko: 'HTML 보고서', nl: 'HTML-rapport', pl: 'Raport HTML', pt: 'Relatório HTML',
    ro: 'Raport HTML', ru: 'HTML-отчёт', sl: 'HTML poročilo', sq: 'Raport HTML', sr: 'HTML izveštaj',
    sv: 'HTML-rapport', tr: 'HTML Raporu', uk: 'HTML-звіт', 'zh-Hans': 'HTML 报告', 'zh-Hant': 'HTML 報告',
  },
  'Print / PDF': {
    bg: 'Печат / PDF', cs: 'Tisk / PDF', de: 'Drucken / PDF', el: 'Εκτύπωση / PDF', en: 'Print / PDF',
    es: 'Imprimir / PDF', fr: 'Imprimer / PDF', hr: 'Ispis / PDF', hu: 'Nyomtatás / PDF', it: 'Stampa / PDF',
    ja: '印刷 / PDF', ko: '인쇄 / PDF', nl: 'Afdrukken / PDF', pl: 'Drukuj / PDF', pt: 'Imprimir / PDF',
    ro: 'Tipărire / PDF', ru: 'Печать / PDF', sl: 'Tisk / PDF', sq: 'Printo / PDF', sr: 'Štampa / PDF',
    sv: 'Skriv ut / PDF', tr: 'Yazdır / PDF', uk: 'Друк / PDF', 'zh-Hans': '打印 / PDF', 'zh-Hant': '列印 / PDF',
  },
  'Copy Markdown': {
    bg: 'Копирай Markdown', cs: 'Kopírovat Markdown', de: 'Markdown kopieren', el: 'Αντιγραφή Markdown', en: 'Copy Markdown',
    es: 'Copiar Markdown', fr: 'Copier en Markdown', hr: 'Kopiraj Markdown', hu: 'Markdown másolása', it: 'Copia Markdown',
    ja: 'Markdownをコピー', ko: 'Markdown 복사', nl: 'Markdown kopiëren', pl: 'Kopiuj Markdown', pt: 'Copiar Markdown',
    ro: 'Copiază Markdown', ru: 'Копировать Markdown', sl: 'Kopiraj Markdown', sq: 'Kopjo Markdown', sr: 'Kopiraj Markdown',
    sv: 'Kopiera Markdown', tr: 'Markdown Kopyala', uk: 'Копіювати Markdown', 'zh-Hans': '复制 Markdown', 'zh-Hant': '複製 Markdown',
  },

  // Pro Views & Common
  'Map Finder': {
    bg: 'Търсач на карти', cs: 'Vyhledávač map', de: 'Kennfeld-Finder', el: 'Εύρεση χαρτών', en: 'Map Finder',
    es: 'Buscador de mapas', fr: 'Détecteur de cartes', hr: 'Tražilica mapa', hu: 'Térképkereső', it: 'Ricerca mappe',
    ja: 'マップファインダー', ko: '맵 파인더', nl: 'Mapzoeker', pl: 'Wyszukiwarka map', pt: 'Localizador de mapas',
    ro: 'Căutător de hărți', ru: 'Поиск карт', sl: 'Iskalnik map', sq: 'Kërkuesi i hartave', sr: 'Tražilac mapa',
    sv: 'Kartsökare', tr: 'Harita Bulucu', uk: 'Пошук карт', 'zh-Hans': '图谱查找器', 'zh-Hant': '圖譜尋找器',
  },
  'DTC Scanner': {
    bg: 'DTC скенер', cs: 'DTC skener', de: 'DTC-Scanner', el: 'Σαρωτής DTC', en: 'DTC Scanner',
    es: 'Escáner DTC', fr: 'Scanner DTC', hr: 'DTC skener', hu: 'DTC szkenner', it: 'Scanner DTC',
    ja: 'DTCスキャナー', ko: 'DTC 스캐너', nl: 'DTC-scanner', pl: 'Skaner DTC', pt: 'Scanner DTC',
    ro: 'Scanner DTC', ru: 'Сканер DTC', sl: 'DTC skener', sq: 'Skaneri DTC', sr: 'DTC skener',
    sv: 'DTC-skanner', tr: 'DTC Tarayıcı', uk: 'Сканер DTC', 'zh-Hans': 'DTC 故障码扫描器', 'zh-Hant': 'DTC 故障碼掃描器',
  },
  'Tune Porting': {
    bg: 'Пренасяне на тунинг', cs: 'Portování ladění', de: 'Tune-Portierung', el: 'Μεταφορά ρύθμισης', en: 'Tune Porting',
    es: 'Portabilidad de ajuste', fr: 'Portage de cartographie', hr: 'Prijenos tuninga', hu: 'Hangolás átvitele', it: 'Porting mappatura',
    ja: 'チューン移植', ko: '튠 포팅', nl: 'Tune-porting', pl: 'Przenoszenie tuningu', pt: 'Porte de calibração',
    ro: 'Portare calibrare', ru: 'Перенос тюнинга', sl: 'Prenos nastavitve', sq: 'Bartja e kalibrimit', sr: 'Prenos tjuninga',
    sv: 'Tune-portning', tr: 'Ayar Aktarımı', uk: 'Перенесення тюнінгу', 'zh-Hans': '标定移植', 'zh-Hant': '標定移植',
  },
  'Batch Tuner': {
    bg: 'Пакетна настройка', cs: 'Dávkový tuner', de: 'Stapel-Tuner', el: 'Μαζική ρύθμιση', en: 'Batch Tuner',
    es: 'Ajuste por lotes', fr: 'Tuner par lots', hr: 'Skupni tuner', hu: 'Kötegelt hangoló', it: 'Tuner batch',
    ja: 'バッチチューナー', ko: '일괄 튜너', nl: 'Batch-tuner', pl: 'Tuner wsadowy', pt: 'Ajuste em lote',
    ro: 'Tuner în lot', ru: 'Пакетный тюнер', sl: 'Paketni tuner', sq: 'Tuner në grup', sr: 'Paketni tjuner',
    sv: 'Batch-tuner', tr: 'Toplu Ayarlayıcı', uk: 'Пакетний тюнер', 'zh-Hans': '批量调校', 'zh-Hant': '批次調校',
  },
  'Scan DTC Tables': {
    bg: 'Сканирай DTC таблици', cs: 'Skenovat DTC tabulky', de: 'DTC-Tabellen scannen', el: 'Σάρωση πινάκων DTC', en: 'Scan DTC Tables',
    es: 'Escanear tablas DTC', fr: 'Scanner les tables DTC', hr: 'Skeniraj DTC tablice', hu: 'DTC táblák vizsgálata', it: 'Scansiona tabelle DTC',
    ja: 'DTCテーブルをスキャン', ko: 'DTC 테이블 스캔', nl: 'DTC-tabellen scannen', pl: 'Skanuj tabele DTC', pt: 'Escanear tabelas DTC',
    ro: 'Scanează tabelele DTC', ru: 'Сканировать таблицы DTC', sl: 'Skeniraj DTC tabele', sq: 'Skano tabelat DTC', sr: 'Skeniraj DTC tabele',
    sv: 'Skanna DTC-tabeller', tr: 'DTC Tablolarını Tara', uk: 'Сканувати таблиці DTC', 'zh-Hans': '扫描 DTC 表', 'zh-Hant': '掃描 DTC 表',
  },
  'Flash Partitions': {
    bg: 'Флаш дялове', cs: 'Flash oddíly', de: 'Flash-Partitionen', el: 'Διαμερίσματα Flash', en: 'Flash Partitions',
    es: 'Particiones Flash', fr: 'Partitions Flash', hr: 'Flash particije', hu: 'Flash partíciók', it: 'Partizioni Flash',
    ja: 'フラッシュパーティション', ko: '플래시 파티션', nl: 'Flash-partities', pl: 'Partycje Flash', pt: 'Partições Flash',
    ro: 'Partiții Flash', ru: 'Разделы Flash', sl: 'Flash particije', sq: 'Ndarjet Flash', sr: 'Flash particije',
    sv: 'Flash-partitioner', tr: 'Flash Bölümleri', uk: 'Розділи Flash', 'zh-Hans': '闪存分区', 'zh-Hant': '快閃記憶體分區',
  },
  'Shared-Axis Pool': {
    bg: 'Пул споделени оси', cs: 'Sdílené osy', de: 'Geteilter Achsen-Pool', el: 'Κοινόχρηστοι άξονες', en: 'Shared-Axis Pool',
    es: 'Grupo de ejes compartidos', fr: 'Pool d’axes partagés', hr: 'Bazen dijeljenih osi', hu: 'Megosztott tengelyek', it: 'Pool assi condivisi',
    ja: '共有軸プール', ko: '공유 축 풀', nl: 'Gedeelde assen', pl: 'Pula współdzielonych osi', pt: 'Pool de eixos compartilhados',
    ro: 'Axe partajate', ru: 'Пул общих осей', sl: 'Skupne osi', sq: 'Boshtet e përbashkëta', sr: 'Zajedničke ose',
    sv: 'Delade axlar', tr: 'Paylaşılan Eksen Havuzu', uk: 'Пул спільних осей', 'zh-Hans': '共享轴池', 'zh-Hant': '共享軸池',
  },
  'Tuning Recipes': {
    bg: 'Тунинг рецепти', cs: 'Tuningové recepty', de: 'Tuning-Rezepte', el: 'Συνταγές ρύθμισης', en: 'Tuning Recipes',
    es: 'Recetas de ajuste', fr: 'Recettes de tuning', hr: 'Tuning recepti', hu: 'Hangolási receptek', it: 'Ricette di tuning',
    ja: 'チューニングレシピ', ko: '튜닝 레시피', nl: 'Tuningrecepten', pl: 'Receptury tuningu', pt: 'Receitas de calibração',
    ro: 'Rețete de tuning', ru: 'Рецепты тюнинга', sl: 'Tuning recepti', sq: 'Receta kalibrimi', sr: 'Tjuning recepti',
    sv: 'Tuningrecept', tr: 'Ayar Reçeteleri', uk: 'Рецепти тюнінгу', 'zh-Hans': '调校方案', 'zh-Hant': '調校方案',
  },
  'JS Plugins': {
    bg: 'JS добавки', cs: 'JS pluginy', de: 'JS-Plugins', el: 'Πρόσθετα JS', en: 'JS Plugins',
    es: 'Plugins JS', fr: 'Plugins JS', hr: 'JS dodaci', hu: 'JS bővítmények', it: 'Plugin JS',
    ja: 'JSプラグイン', ko: 'JS 플러그인', nl: 'JS-plug-ins', pl: 'Wtyczki JS', pt: 'Plugins JS',
    ro: 'Pluginuri JS', ru: 'JS-плагины', sl: 'JS vtičniki', sq: 'Shtojca JS', sr: 'JS dodaci',
    sv: 'JS-tillägg', tr: 'JS Eklentileri', uk: 'JS-плагіни', 'zh-Hans': 'JS 插件', 'zh-Hant': 'JS 外掛',
  },
  'Reference Library': {
    bg: 'Справочна библиотека', cs: 'Referenční knihovna', de: 'Referenzbibliothek', el: 'Βιβλιοθήκη αναφοράς', en: 'Reference Library',
    es: 'Biblioteca de referencia', fr: 'Bibliothèque de référence', hr: 'Referentna biblioteka', hu: 'Referenciakönyvtár', it: 'Libreria di riferimento',
    ja: 'リファレンスライブラリ', ko: '참조 라이브러리', nl: 'Referentiebibliotheek', pl: 'Biblioteka referencyjna', pt: 'Biblioteca de referência',
    ro: 'Bibliotecă de referință', ru: 'Справочная библиотека', sl: 'Referenčna knjižnica', sq: 'Biblioteka e referencës', sr: 'Referentna biblioteka',
    sv: 'Referensbibliotek', tr: 'Referans Kitaplığı', uk: 'Довідкова бібліотека', 'zh-Hans': '参考库', 'zh-Hant': '參考庫',
  },
  'Time-Series': {
    bg: 'Времеви редове', cs: 'Časové řady', de: 'Zeitreihen', el: 'Χρονοσειρές', en: 'Time-Series',
    es: 'Series temporales', fr: 'Séries temporelles', hr: 'Vremenski nizovi', hu: 'Idősorok', it: 'Serie temporali',
    ja: '時系列', ko: '시계열', nl: 'Tijdreeksen', pl: 'Szeregi czasowe', pt: 'Séries temporais',
    ro: 'Serii temporale', ru: 'Временные ряды', sl: 'Časovne vrste', sq: 'Seri kohore', sr: 'Vremenske serije',
    sv: 'Tidsserier', tr: 'Zaman Serisi', uk: 'Часові ряди', 'zh-Hans': '时间序列', 'zh-Hant': '時間序列',
  },
  'XY Scatter': {
    bg: 'XY диаграма', cs: 'XY bodový graf', de: 'XY-Streudiagramm', el: 'Διάγραμμα διασποράς XY', en: 'XY Scatter',
    es: 'Dispersión XY', fr: 'Nuage XY', hr: 'XY raspršenje', hu: 'XY szórásdiagram', it: 'Dispersione XY',
    ja: 'XY散布図', ko: 'XY 산점도', nl: 'XY-spreiding', pl: 'Wykres XY', pt: 'Dispersão XY',
    ro: 'Dispersie XY', ru: 'XY-диаграмма', sl: 'XY raztros', sq: 'Shpërndarja XY', sr: 'XY dijagram',
    sv: 'XY-spridning', tr: 'XY Dağılım', uk: 'XY-діаграма', 'zh-Hans': 'XY 散点图', 'zh-Hant': 'XY 散點圖',
  },
  'Virtual Dyno': {
    bg: 'Виртуален дино', cs: 'Virtuální dyno', de: 'Virtueller Prüfstand', el: 'Εικονικό δυναμόμετρο', en: 'Virtual Dyno',
    es: 'Banco virtual', fr: 'Banc virtuel', hr: 'Virtualni dyno', hu: 'Virtuális fékpad', it: 'Banco virtuale',
    ja: 'バーチャルダイノ', ko: '가상 다이노', nl: 'Virtuele dyno', pl: 'Wirtualna hamownia', pt: 'Dinamômetro virtual',
    ro: 'Dyno virtual', ru: 'Виртуальный диностенд', sl: 'Navidezni dyno', sq: 'Dyno virtual', sr: 'Virtuelni dino',
    sv: 'Virtuell dyno', tr: 'Sanal Dyno', uk: 'Віртуальний диностенд', 'zh-Hans': '虚拟马力机', 'zh-Hant': '虛擬馬力機',
  },
  'Auto-Tune': {
    bg: 'Авто-тунинг', cs: 'Auto-ladění', de: 'Auto-Tune', el: 'Αυτόματη ρύθμιση', en: 'Auto-Tune',
    es: 'Auto-ajuste', fr: 'Auto-Tune', hr: 'Auto-tuning', hu: 'Auto-hangolás', it: 'Auto-Tune',
    ja: 'オートチューン', ko: '오토 튠', nl: 'Auto-Tune', pl: 'Auto-strojenie', pt: 'Auto-ajuste',
    ro: 'Auto-Tune', ru: 'Авто-настройка', sl: 'Auto-Tune', sq: 'Auto-Tune', sr: 'Auto-tjuning',
    sv: 'Auto-Tune', tr: 'Otomatik Ayar', uk: 'Авто-налаштування', 'zh-Hans': '自动调校', 'zh-Hant': '自動調校',
  },
  'Live OBD-II': {
    bg: 'OBD-II на живо', cs: 'Živé OBD-II', de: 'Live OBD-II', el: 'Ζωντανό OBD-II', en: 'Live OBD-II',
    es: 'OBD-II en vivo', fr: 'OBD-II en direct', hr: 'OBD-II uživo', hu: 'Élő OBD-II', it: 'OBD-II live',
    ja: 'ライブOBD-II', ko: '실시간 OBD-II', nl: 'Live OBD-II', pl: 'OBD-II na żywo', pt: 'OBD-II ao vivo',
    ro: 'OBD-II live', ru: 'OBD-II в реальном времени', sl: 'OBD-II v živo', sq: 'OBD-II drejtpërdrejt', sr: 'OBD-II uživo',
    sv: 'Live OBD-II', tr: 'Canlı OBD-II', uk: 'OBD-II наживо', 'zh-Hans': '实时 OBD-II', 'zh-Hant': '即時 OBD-II',
  },
  'Preflight & Checksums': {
    bg: 'Проверка и контролни суми', cs: 'Kontrola a kontrolní součty', de: 'Vorabprüfung & Prüfsummen', el: 'Προέλεγχος & Checksums', en: 'Preflight & Checksums',
    es: 'Preverificación y checksums', fr: 'Vérification & sommes de contrôle', hr: 'Provjera i kontrolni zbrojevi', hu: 'Előellenőrzés és checksumok', it: 'Verifica e checksum',
    ja: '事前チェック＆チェックサム', ko: '사전 점검 및 체크섬', nl: 'Controle & checksums', pl: 'Kontrola i sumy kontrolne', pt: 'Pré-verificação e checksums',
    ro: 'Verificare și sume de control', ru: 'Проверка и контрольные суммы', sl: 'Predpregled in kontrolne vsote', sq: 'Parakontrolli & shumat e kontrollit', sr: 'Provera i kontrolne sume',
    sv: 'Förkontroll & kontrollsummor', tr: 'Ön Kontrol ve Sağlama Toplamları', uk: 'Перевірка та контрольні суми', 'zh-Hans': '刷前检查与校验和', 'zh-Hant': '刷前檢查與校驗和',
  },
  'Diagnostics & Lint': {
    bg: 'Диагностика и проверки', cs: 'Diagnostika a kontrola', de: 'Diagnose & Prüfung', el: 'Διαγνωστικά & Έλεγχος', en: 'Diagnostics & Lint',
    es: 'Diagnóstico y validación', fr: 'Diagnostics & Lint', hr: 'Dijagnostika i provjera', hu: 'Diagnosztika és ellenőrzés', it: 'Diagnostica e controlli',
    ja: '診断＆リント', ko: '진단 및 검사', nl: 'Diagnostiek & lint', pl: 'Diagnostyka i kontrola', pt: 'Diagnóstico e validação',
    ro: 'Diagnostic și verificare', ru: 'Диагностика и проверка', sl: 'Diagnostika in preverjanje', sq: 'Diagnostika & kontrolli', sr: 'Dijagnostika i provera',
    sv: 'Diagnostik & kontroll', tr: 'Tanılama ve Doğrulama', uk: 'Діагностика та перевірка', 'zh-Hans': '诊断与检查', 'zh-Hant': '診斷與檢查',
  },
  'Snapshots': {
    bg: 'Снимки', cs: 'Snímky', de: 'Schnappschüsse', el: 'Στιγμιότυπα', en: 'Snapshots',
    es: 'Instantáneas', fr: 'Instantanés', hr: 'Snimke', hu: 'Pillanatképek', it: 'Istantanee',
    ja: 'スナップショット', ko: '스냅샷', nl: 'Momentopnamen', pl: 'Migawki', pt: 'Instantâneos',
    ro: 'Instantanee', ru: 'Снимки', sl: 'Posnetki', sq: 'Pamje', sr: 'Snimci',
    sv: 'Ögonblicksbilder', tr: 'Anlık Görüntüler', uk: 'Знімки', 'zh-Hans': '快照', 'zh-Hant': '快照',
  },
  'Edit History': {
    bg: 'История на редакциите', cs: 'Historie úprav', de: 'Bearbeitungsverlauf', el: 'Ιστορικό επεξεργασιών', en: 'Edit History',
    es: 'Historial de cambios', fr: 'Historique des modifications', hr: 'Povijest izmjena', hu: 'Szerkesztési előzmények', it: 'Cronologia modifiche',
    ja: '編集履歴', ko: '편집 기록', nl: 'Bewerkingsgeschiedenis', pl: 'Historia zmian', pt: 'Histórico de edições',
    ro: 'Istoric modificări', ru: 'История правок', sl: 'Zgodovina urejanj', sq: 'Historia e redaktimeve', sr: 'Istorija izmena',
    sv: 'Redigeringshistorik', tr: 'Düzenleme Geçmişi', uk: 'Історія правок', 'zh-Hans': '编辑历史', 'zh-Hant': '編輯歷史',
  },
  'Report Export': {
    bg: 'Експорт на отчет', cs: 'Export zprávy', de: 'Berichtsexport', el: 'Εξαγωγή αναφοράς', en: 'Report Export',
    es: 'Exportar informe', fr: 'Export de rapport', hr: 'Izvoz izvješća', hu: 'Jelentés exportálása', it: 'Esportazione report',
    ja: 'レポート書き出し', ko: '보고서 내보내기', nl: 'Rapport exporteren', pl: 'Eksport raportu', pt: 'Exportar relatório',
    ro: 'Export raport', ru: 'Экспорт отчёта', sl: 'Izvoz poročila', sq: 'Eksporti i raportit', sr: 'Izvoz izveštaja',
    sv: 'Rapportexport', tr: 'Rapor Dışa Aktarımı', uk: 'Експорт звіту', 'zh-Hans': '导出报告', 'zh-Hant': '匯出報告',
  },
  'Auto-Detect': {
    bg: 'Авто-откриване', cs: 'Auto-detekce', de: 'Auto-Erkennung', el: 'Αυτόματος εντοπισμός', en: 'Auto-Detect',
    es: 'Autodetectar', fr: 'Détection auto', hr: 'Automatski otkrij', hu: 'Automatikus felismerés', it: 'Rilevamento automatico',
    ja: '自動検出', ko: '자동 감지', nl: 'Automatisch detecteren', pl: 'Auto-wykrywanie', pt: 'Detecção automática',
    ro: 'Detectare automată', ru: 'Автоопределение', sl: 'Samodejno zaznaj', sq: 'Zbulo automatikisht', sr: 'Automatski otkrij',
    sv: 'Autodetektera', tr: 'Otomatik Algıla', uk: 'Автовизначення', 'zh-Hans': '自动检测', 'zh-Hant': '自動偵測',
  },
  'Fix CVN In-Place': {
    bg: 'Коригирай CVN на място', cs: 'Opravit CVN na místě', de: 'CVN direkt korrigieren', el: 'Διόρθωση CVN επί τόπου', en: 'Fix CVN In-Place',
    es: 'Corregir CVN in situ', fr: 'Corriger le CVN sur place', hr: 'Popravi CVN na mjestu', hu: 'CVN javítása helyben', it: 'Correggi CVN sul posto',
    ja: 'CVNをその場で修正', ko: 'CVN 제자리 수정', nl: 'CVN ter plaatse herstellen', pl: 'Napraw CVN w miejscu', pt: 'Corrigir CVN no local',
    ro: 'Corectează CVN pe loc', ru: 'Исправить CVN на месте', sl: 'Popravi CVN na mestu', sq: 'Rregullo CVN në vend', sr: 'Popravi CVN na mestu',
    sv: 'Åtgärda CVN på plats', tr: 'CVN’yi Yerinde Düzelt', uk: 'Виправити CVN на місці', 'zh-Hans': '就地修复 CVN', 'zh-Hant': '就地修復 CVN',
  },
  'Forgotten Twins': {
    bg: 'Забравени близнаци', cs: 'Zapomenutá dvojčata', de: 'Vergessene Zwillinge', el: 'Ξεχασμένα δίδυμα', en: 'Forgotten Twins',
    es: 'Gemelos olvidados', fr: 'Jumeaux oubliés', hr: 'Zaboravljeni blizanci', hu: 'Elfelejtett ikrek', it: 'Gemelli dimenticati',
    ja: '未更新のツイン', ko: '누락된 트윈', nl: 'Vergeten tweelingen', pl: 'Zapomniane bliźniaki', pt: 'Gêmeos esquecidos',
    ro: 'Gemeni uitați', ru: 'Забытые двойники', sl: 'Pozabljeni dvojčki', sq: 'Binjakët e harruar', sr: 'Zaboravljeni blizanci',
    sv: 'Glömda tvillingar', tr: 'Unutulan İkizler', uk: 'Забуті двійники', 'zh-Hans': '遗漏的镜像图', 'zh-Hant': '遺漏的鏡像圖',
  },
  'Physics Invariants': {
    bg: 'Физични инварианти', cs: 'Fyzikální invarianty', de: 'Physikalische Invarianten', el: 'Φυσικές αναλλοίωτες', en: 'Physics Invariants',
    es: 'Invariantes físicos', fr: 'Invariants physiques', hr: 'Fizikalne invarijante', hu: 'Fizikai invariánsok', it: 'Invarianti fisici',
    ja: '物理不変条件', ko: '물리 불변량', nl: 'Fysische invarianten', pl: 'Niezmienniki fizyczne', pt: 'Invariantes físicos',
    ro: 'Invarianți fizici', ru: 'Физические инварианты', sl: 'Fizikalne invariante', sq: 'Invariantët fizikë', sr: 'Fizičke invarijante',
    sv: 'Fysikaliska invarianter', tr: 'Fizik Değişmezleri', uk: 'Фізичні інваріанти', 'zh-Hans': '物理不变量', 'zh-Hant': '物理不變量',
  },
  'Bottom Drawer': {
    bg: 'Долен панел', cs: 'Spodní panel', de: 'Unterer Bereich', el: 'Κάτω πλαίσιο', en: 'Bottom Drawer',
    es: 'Panel inferior', fr: 'Tiroir inférieur', hr: 'Donja ladica', hu: 'Alsó panel', it: 'Pannello inferiore',
    ja: '下部ドロワー', ko: '하단 패널', nl: 'Onderpaneel', pl: 'Dolny panel', pt: 'Painel inferior',
    ro: 'Panou inferior', ru: 'Нижняя панель', sl: 'Spodnji predal', sq: 'Paneli i poshtëm', sr: 'Donji panel',
    sv: 'Nedre panel', tr: 'Alt Panel', uk: 'Нижня панель', 'zh-Hans': '底部抽屉', 'zh-Hant': '底部抽屜',
  },
  'Inspector': {
    bg: 'Инспектор', cs: 'Inspektor', de: 'Inspektor', el: 'Επιθεωρητής', en: 'Inspector',
    es: 'Inspector', fr: 'Inspecteur', hr: 'Inspektor', hu: 'Inspektor', it: 'Ispettore',
    ja: 'インスペクタ', ko: '인스펙터', nl: 'Inspector', pl: 'Inspektor', pt: 'Inspetor',
    ro: 'Inspector', ru: 'Инспектор', sl: 'Inšpektor', sq: 'Inspektori', sr: 'Inspektor',
    sv: 'Inspektör', tr: 'Denetleyici', uk: 'Інспектор', 'zh-Hans': '检查器', 'zh-Hant': '檢查器',
  },
  'Checksum OK': {
    bg: 'Контролна сума OK', cs: 'Kontrolní součet OK', de: 'Prüfsumme OK', el: 'Checksum OK', en: 'Checksum OK',
    es: 'Checksum OK', fr: 'Somme de contrôle OK', hr: 'Kontrolni zbroj OK', hu: 'Ellenőrzőösszeg OK', it: 'Checksum OK',
    ja: 'チェックサム正常', ko: '체크섬 정상', nl: 'Checksum OK', pl: 'Suma kontrolna OK', pt: 'Checksum OK',
    ro: 'Sumă de control OK', ru: 'Контрольная сумма OK', sl: 'Kontrolna vsota OK', sq: 'Shuma e kontrollit OK', sr: 'Kontrolna suma OK',
    sv: 'Kontrollsumma OK', tr: 'Sağlama Toplamı OK', uk: 'Контрольна сума OK', 'zh-Hans': '校验和正常', 'zh-Hant': '校驗和正常',
  },
  'Checksum Invalid': {
    bg: 'Невалидна контролна сума', cs: 'Neplatný kontrolní součet', de: 'Prüfsumme ungültig', el: 'Μη έγκυρο Checksum', en: 'Checksum Invalid',
    es: 'Checksum no válido', fr: 'Somme de contrôle invalide', hr: 'Neispravan kontrolni zbroj', hu: 'Érvénytelen ellenőrzőösszeg', it: 'Checksum non valido',
    ja: 'チェックサム不正', ko: '체크섬 오류', nl: 'Checksum ongeldig', pl: 'Nieprawidłowa suma kontrolna', pt: 'Checksum inválido',
    ro: 'Sumă de control invalidă', ru: 'Неверная контрольная сумма', sl: 'Neveljavna kontrolna vsota', sq: 'Shumë kontrolli e pavlefshme', sr: 'Neispravna kontrolna suma',
    sv: 'Ogiltig kontrollsumma', tr: 'Geçersiz Sağlama Toplamı', uk: 'Недійсна контрольна сума', 'zh-Hans': '校验和无效', 'zh-Hant': '校驗和無效',
  },
  'Open': {
    bg: 'Отвори', cs: 'Otevřít', de: 'Öffnen', el: 'Άνοιγμα', en: 'Open',
    es: 'Abrir', fr: 'Ouvrir', hr: 'Otvori', hu: 'Megnyitás', it: 'Apri',
    ja: '開く', ko: '열기', nl: 'Openen', pl: 'Otwórz', pt: 'Abrir',
    ro: 'Deschide', ru: 'Открыть', sl: 'Odpri', sq: 'Hap', sr: 'Otvori',
    sv: 'Öppna', tr: 'Aç', uk: 'Відкрити', 'zh-Hans': '打开', 'zh-Hant': '開啟',
  },
  'Export': {
    bg: 'Експорт', cs: 'Export', de: 'Exportieren', el: 'Εξαγωγή', en: 'Export',
    es: 'Exportar', fr: 'Exporter', hr: 'Izvoz', hu: 'Exportálás', it: 'Esporta',
    ja: '書き出し', ko: '내보내기', nl: 'Exporteren', pl: 'Eksportuj', pt: 'Exportar',
    ro: 'Exportă', ru: 'Экспорт', sl: 'Izvoz', sq: 'Eksporto', sr: 'Izvoz',
    sv: 'Exportera', tr: 'Dışa Aktar', uk: 'Експорт', 'zh-Hans': '导出', 'zh-Hant': '匯出',
  },
  'Export Def': {
    bg: 'Експорт деф.', cs: 'Export def.', de: 'Def. exportieren', el: 'Εξαγωγή ορισμού', en: 'Export Def',
    es: 'Exportar def.', fr: 'Exporter déf.', hr: 'Izvezi def.', hu: 'Def. export', it: 'Esporta def.',
    ja: '定義を書き出し', ko: '정의 내보내기', nl: 'Def. exporteren', pl: 'Eksportuj def.', pt: 'Exportar def.',
    ro: 'Exportă def.', ru: 'Экспорт XDF', sl: 'Izvozi def.', sq: 'Eksporto def.', sr: 'Izvezi def.',
    sv: 'Exportera def.', tr: 'Tanımı Dışa Aktar', uk: 'Експорт XDF', 'zh-Hans': '导出定义', 'zh-Hant': '匯出定義',
  },
  'Theme': {
    bg: 'Тема', cs: 'Motiv', de: 'Design', el: 'Θέμα', en: 'Theme',
    es: 'Tema', fr: 'Thème', hr: 'Tema', hu: 'Téma', it: 'Tema',
    ja: 'テーマ', ko: '테마', nl: 'Thema', pl: 'Motyw', pt: 'Tema',
    ro: 'Temă', ru: 'Тема', sl: 'Tema', sq: 'Tema', sr: 'Tema',
    sv: 'Tema', tr: 'Tema', uk: 'Тема', 'zh-Hans': '主题', 'zh-Hant': '主題',
  },
  'Units': {
    bg: 'Единици', cs: 'Jednotky', de: 'Einheiten', el: 'Μονάδες', en: 'Units',
    es: 'Unidades', fr: 'Unités', hr: 'Jedinice', hu: 'Egységek', it: 'Unità',
    ja: '単位', ko: '단위', nl: 'Eenheden', pl: 'Jednostki', pt: 'Unidades',
    ro: 'Unități', ru: 'Единицы', sl: 'Enote', sq: 'Njësitë', sr: 'Jedinice',
    sv: 'Enheter', tr: 'Birimler', uk: 'Одиниці', 'zh-Hans': '单位', 'zh-Hant': '單位',
  },
  'Layout': {
    bg: 'Оформление', cs: 'Rozvržení', de: 'Layout', el: 'Διάταξη', en: 'Layout',
    es: 'Diseño', fr: 'Disposition', hr: 'Raspored', hu: 'Elrendezés', it: 'Layout',
    ja: 'レイアウト', ko: '레이아웃', nl: 'Indeling', pl: 'Układ', pt: 'Layout',
    ro: 'Aspect', ru: 'Макет', sl: 'Postavitev', sq: 'Paraqitja', sr: 'Raspored',
    sv: 'Layout', tr: 'Düzen', uk: 'Макет', 'zh-Hans': '布局', 'zh-Hant': '版面配置',
  },
  'Palette': {
    bg: 'Палитра', cs: 'Paleta', de: 'Palette', el: 'Παλέτα', en: 'Palette',
    es: 'Paleta', fr: 'Palette', hr: 'Paleta', hu: 'Paletta', it: 'Palette',
    ja: 'パレット', ko: '팔레트', nl: 'Palet', pl: 'Paleta', pt: 'Paleta',
    ro: 'Paletă', ru: 'Палитра', sl: 'Paleta', sq: 'Paleta', sr: 'Paleta',
    sv: 'Palett', tr: 'Palet', uk: 'Палітра', 'zh-Hans': '配色', 'zh-Hant': '配色',
  },
  'Language': {
    bg: 'Език', cs: 'Jazyk', de: 'Sprache', el: 'Γλώσσα', en: 'Language',
    es: 'Idioma', fr: 'Langue', hr: 'Jezik', hu: 'Nyelv', it: 'Lingua',
    ja: '言語', ko: '언어', nl: 'Taal', pl: 'Język', pt: 'Idioma',
    ro: 'Limbă', ru: 'Язык', sl: 'Jezik', sq: 'Gjuha', sr: 'Jezik',
    sv: 'Språk', tr: 'Dil', uk: 'Мова', 'zh-Hans': '语言', 'zh-Hant': '語言',
  },
  'Save': {
    bg: 'Запази', cs: 'Uložit', de: 'Speichern', el: 'Αποθήκευση', en: 'Save',
    es: 'Guardar', fr: 'Enregistrer', hr: 'Spremi', hu: 'Mentés', it: 'Salva',
    ja: '保存', ko: '저장', nl: 'Opslaan', pl: 'Zapisz', pt: 'Salvar',
    ro: 'Salvează', ru: 'Сохранить', sl: 'Shrani', sq: 'Ruaj', sr: 'Sačuvaj',
    sv: 'Spara', tr: 'Kaydet', uk: 'Зберегти', 'zh-Hans': '保存', 'zh-Hant': '儲存',
  },
  'Cancel': {
    bg: 'Отказ', cs: 'Zrušit', de: 'Abbrechen', el: 'Ακύρωση', en: 'Cancel',
    es: 'Cancelar', fr: 'Annuler', hr: 'Odustani', hu: 'Mégse', it: 'Annulla',
    ja: 'キャンセル', ko: '취소', nl: 'Annuleren', pl: 'Anuluj', pt: 'Cancelar',
    ro: 'Anulează', ru: 'Отмена', sl: 'Prekliči', sq: 'Anulo', sr: 'Otkaži',
    sv: 'Avbryt', tr: 'İptal', uk: 'Скасувати', 'zh-Hans': '取消', 'zh-Hant': '取消',
  },
  'Close': {
    bg: 'Затвори', cs: 'Zavřít', de: 'Schließen', el: 'Κλείσιμο', en: 'Close',
    es: 'Cerrar', fr: 'Fermer', hr: 'Zatvori', hu: 'Bezárás', it: 'Chiudi',
    ja: '閉じる', ko: '닫기', nl: 'Sluiten', pl: 'Zamknij', pt: 'Fechar',
    ro: 'Închide', ru: 'Закрыть', sl: 'Zapri', sq: 'Mbyll', sr: 'Zatvori',
    sv: 'Stäng', tr: 'Kapat', uk: 'Закрити', 'zh-Hans': '关闭', 'zh-Hant': '關閉',
  },
  'Apply': {
    bg: 'Приложи', cs: 'Použít', de: 'Anwenden', el: 'Εφαρμογή', en: 'Apply',
    es: 'Aplicar', fr: 'Appliquer', hr: 'Primijeni', hu: 'Alkalmaz', it: 'Applica',
    ja: '適用', ko: '적용', nl: 'Toepassen', pl: 'Zastosuj', pt: 'Aplicar',
    ro: 'Aplică', ru: 'Применить', sl: 'Uporabi', sq: 'Zbato', sr: 'Primeni',
    sv: 'Använd', tr: 'Uygula', uk: 'Застосувати', 'zh-Hans': '应用', 'zh-Hant': '套用',
  },
  'Delete': {
    bg: 'Изтрий', cs: 'Smazat', de: 'Löschen', el: 'Διαγραφή', en: 'Delete',
    es: 'Eliminar', fr: 'Supprimer', hr: 'Izbriši', hu: 'Törlés', it: 'Elimina',
    ja: '削除', ko: '삭제', nl: 'Verwijderen', pl: 'Usuń', pt: 'Excluir',
    ro: 'Șterge', ru: 'Удалить', sl: 'Izbriši', sq: 'Fshi', sr: 'Obriši',
    sv: 'Radera', tr: 'Sil', uk: 'Видалити', 'zh-Hans': '删除', 'zh-Hant': '刪除',
  },
  'Add': {
    bg: 'Добави', cs: 'Přidat', de: 'Hinzufügen', el: 'Προσθήκη', en: 'Add',
    es: 'Añadir', fr: 'Ajouter', hr: 'Dodaj', hu: 'Hozzáadás', it: 'Aggiungi',
    ja: '追加', ko: '추가', nl: 'Toevoegen', pl: 'Dodaj', pt: 'Adicionar',
    ro: 'Adaugă', ru: 'Добавить', sl: 'Dodaj', sq: 'Shto', sr: 'Dodaj',
    sv: 'Lägg till', tr: 'Ekle', uk: 'Додати', 'zh-Hans': '添加', 'zh-Hant': '新增',
  },
  'Create': {
    bg: 'Създай', cs: 'Vytvořit', de: 'Erstellen', el: 'Δημιουργία', en: 'Create',
    es: 'Crear', fr: 'Créer', hr: 'Stvori', hu: 'Létrehozás', it: 'Crea',
    ja: '作成', ko: '생성', nl: 'Aanmaken', pl: 'Utwórz', pt: 'Criar',
    ro: 'Creează', ru: 'Создать', sl: 'Ustvari', sq: 'Krijo', sr: 'Napravi',
    sv: 'Skapa', tr: 'Oluştur', uk: 'Створити', 'zh-Hans': '创建', 'zh-Hant': '建立',
  },
  'Download': {
    bg: 'Изтегли', cs: 'Stáhnout', de: 'Herunterladen', el: 'Λήψη', en: 'Download',
    es: 'Descargar', fr: 'Télécharger', hr: 'Preuzmi', hu: 'Letöltés', it: 'Scarica',
    ja: 'ダウンロード', ko: '다운로드', nl: 'Downloaden', pl: 'Pobierz', pt: 'Baixar',
    ro: 'Descarcă', ru: 'Скачать', sl: 'Prenesi', sq: 'Shkarko', sr: 'Preuzmi',
    sv: 'Ladda ner', tr: 'İndir', uk: 'Завантажити', 'zh-Hans': '下载', 'zh-Hant': '下載',
  },
  'Preview': {
    bg: 'Преглед', cs: 'Náhled', de: 'Vorschau', el: 'Προεπισκόπηση', en: 'Preview',
    es: 'Vista previa', fr: 'Aperçu', hr: 'Pregled', hu: 'Előnézet', it: 'Anteprima',
    ja: 'プレビュー', ko: '미리보기', nl: 'Voorbeeld', pl: 'Podgląd', pt: 'Pré-visualizar',
    ro: 'Previzualizare', ru: 'Предпросмотр', sl: 'Predogled', sq: 'Parapamje', sr: 'Pregled',
    sv: 'Förhandsgranska', tr: 'Önizleme', uk: 'Попередній перегляд', 'zh-Hans': '预览', 'zh-Hant': '預覽',
  },
};

function main() {
  const enPath = path.join(LOCALIZATION_DIR, 'en.lproj', 'Localizable.strings');
  if (!fs.existsSync(enPath)) {
    throw new Error(`Missing English Localizable.strings at ${enPath}`);
  }

  const enMap = parseStringsFile(enPath);
  const output = {};

  for (const locale of ALL_LOCALES) {
    const lprojPath = path.join(LOCALIZATION_DIR, `${locale}.lproj`, 'Localizable.strings');
    if (!fs.existsSync(lprojPath)) {
      throw new Error(`Missing Localizable.strings for ${locale} at ${lprojPath}`);
    }

    const localeMap = parseStringsFile(lprojPath);
    const strings = Object.create(null);

    // 1. Import all strings from .lproj keyed by English canonical text
    for (const [swiftKey, localizedText] of localeMap.entries()) {
      const englishText = enMap.get(swiftKey);
      if (englishText && localizedText) {
        if (!(englishText in strings)) {
          strings[englishText] = localizedText;
        }
      }
    }

    // 2. Overlay comprehensive React UI strings for all 25 locales
    for (const [englishKey, translations] of Object.entries(REACT_UI_STRINGS)) {
      const val = translations[locale] ?? translations.en ?? englishKey;
      strings[englishKey] = val;
    }

    // Sort keys deterministically for clean diffs & deduplication
    const sortedStrings = {};
    for (const key of Object.keys(strings).sort()) {
      sortedStrings[key] = strings[key];
    }

    output[locale] = {
      name: LOCALE_NAMES[locale],
      strings: sortedStrings,
    };
  }

  // Write compact valid JSON
  const json = JSON.stringify(output);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, json, 'utf8');

  const sizeBytes = Buffer.byteLength(json, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH} (${(sizeBytes / 1024).toFixed(1)} KB, ${sizeBytes} bytes)`);
  for (const locale of ALL_LOCALES) {
    const count = Object.keys(output[locale].strings).length;
    console.log(`  ${locale.padEnd(8)} (${LOCALE_NAMES[locale]}): ${count} keys`);
  }
}

main();
