import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'catalog-seed' });

interface SeedProduct {
  ean: string;
  name: string;
  brand: string;
  packSize: string;
  category: string;
  mrp: number;
  gstRate: 0 | 5 | 12 | 18 | 28;
  shelfLifeDays: number;
}

interface IndianSkuBase {
  name: string;
  brand: string;
  category: string;
  gstRate: 0 | 5 | 12 | 18 | 28;
  shelfLifeDays: number;
  variants: Array<[packSize: string, mrp: number]>;
}

const INDIAN_KIRANA_CATALOG: IndianSkuBase[] = [
  {
    name: 'Parle-G Original Gluco Biscuits',
    brand: 'Parle',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['50g', 5],
      ['100g', 10],
      ['250g', 25],
      ['800g', 85],
    ],
  },
  {
    name: 'Parle Krackjack Sweet & Salty Biscuits',
    brand: 'Parle',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['60g', 10],
      ['200g', 35],
    ],
  },
  {
    name: 'Parle Hide & Seek Chocolate Chip Cookies',
    brand: 'Parle',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['100g', 30],
      ['200g', 60],
    ],
  },
  {
    name: 'Maggi 2-Minute Masala Noodles',
    brand: 'Nestle',
    category: 'Noodles & Pasta',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['70g', 14],
      ['140g', 28],
      ['280g', 56],
      ['560g', 110],
    ],
  },
  {
    name: 'Maggi Nutri-Licious Masala Veg Atta Noodles',
    brand: 'Nestle',
    category: 'Noodles & Pasta',
    gstRate: 18,
    shelfLifeDays: 240,
    variants: [
      ['72.5g', 25],
      ['290g', 95],
    ],
  },
  {
    name: 'Yippee Magic Masala Noodles',
    brand: 'Sunfeast',
    category: 'Noodles & Pasta',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['67.5g', 14],
      ['270g', 55],
    ],
  },
  {
    name: 'Tata Salt Vacuum Evaporated Iodised Salt',
    brand: 'Tata',
    category: 'Staples',
    gstRate: 0,
    shelfLifeDays: 730,
    variants: [
      ['500g', 15],
      ['1kg', 28],
      ['2kg', 55],
    ],
  },
  {
    name: 'Tata Sampann Unpolished Toor Dal',
    brand: 'Tata',
    category: 'Pulses',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['500g', 110],
      ['1kg', 215],
    ],
  },
  {
    name: 'Tata Tea Gold Assam Tea',
    brand: 'Tata',
    category: 'Tea & Coffee',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['100g', 65],
      ['250g', 155],
      ['500g', 305],
    ],
  },
  {
    name: 'Aashirvaad Shudh Chakki Whole Wheat Atta',
    brand: 'Aashirvaad',
    category: 'Flours',
    gstRate: 5,
    shelfLifeDays: 90,
    variants: [
      ['1kg', 56],
      ['2kg', 110],
      ['5kg', 245],
      ['10kg', 470],
    ],
  },
  {
    name: 'Aashirvaad Select Sharbati Atta',
    brand: 'Aashirvaad',
    category: 'Flours',
    gstRate: 5,
    shelfLifeDays: 90,
    variants: [
      ['1kg', 68],
      ['5kg', 325],
    ],
  },
  {
    name: 'Amul Pasteurised Salted Butter',
    brand: 'Amul',
    category: 'Dairy',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['100g', 60],
      ['200g', 118],
      ['500g', 285],
    ],
  },
  {
    name: 'Amul Taaza Toned Milk Tetra Pack',
    brand: 'Amul',
    category: 'Dairy',
    gstRate: 0,
    shelfLifeDays: 180,
    variants: [
      ['200ml', 18],
      ['500ml', 36],
      ['1L', 74],
    ],
  },
  {
    name: 'Amul Pure Cow Ghee',
    brand: 'Amul',
    category: 'Dairy',
    gstRate: 12,
    shelfLifeDays: 270,
    variants: [
      ['200ml', 145],
      ['500ml', 330],
      ['1L', 650],
    ],
  },
  {
    name: 'Amul Processed Cheese Slices',
    brand: 'Amul',
    category: 'Dairy',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['100g', 85],
      ['200g', 145],
    ],
  },
  {
    name: 'Surf Excel Easy Wash Detergent Powder',
    brand: 'Surf Excel',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['100g', 10],
      ['500g', 72],
      ['1kg', 138],
      ['2kg', 270],
    ],
  },
  {
    name: 'Surf Excel Matic Top Load Liquid Detergent',
    brand: 'Surf Excel',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['500ml', 120],
      ['1L', 225],
    ],
  },
  {
    name: 'Vim Lemon Dishwash Bar',
    brand: 'Vim',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['130g', 10],
      ['300g', 30],
      ['500g', 50],
    ],
  },
  {
    name: 'Vim Dishwash Gel Lemon',
    brand: 'Vim',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['250ml', 65],
      ['500ml', 115],
      ['750ml', 175],
    ],
  },
  {
    name: 'Dettol Original Germ Protection Bathing Soap',
    brand: 'Dettol',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['75g', 35],
      ['125g', 62],
      ['4x125g', 230],
    ],
  },
  {
    name: 'Dettol Antiseptic Liquid',
    brand: 'Dettol',
    category: 'Personal Care',
    gstRate: 12,
    shelfLifeDays: 1095,
    variants: [
      ['125ml', 75],
      ['250ml', 145],
      ['550ml', 240],
    ],
  },
  {
    name: 'Lifebuoy Total 10 Germ Protection Soap',
    brand: 'Lifebuoy',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['125g', 38],
      ['4x125g', 142],
    ],
  },
  {
    name: 'Santoor Sandal & Turmeric Soap',
    brand: 'Santoor',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['100g', 36],
      ['4x100g', 135],
      ['4x150g', 195],
    ],
  },
  {
    name: 'Dove Cream Beauty Bathing Bar',
    brand: 'Dove',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['75g', 48],
      ['100g', 65],
      ['3x100g', 185],
    ],
  },
  {
    name: 'Colgate Strong Teeth Anticavity Toothpaste',
    brand: 'Colgate',
    category: 'Oral Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['50g', 32],
      ['100g', 68],
      ['200g', 128],
      ['500g', 285],
    ],
  },
  {
    name: 'Colgate MaxFresh Spicy Fresh Red Gel',
    brand: 'Colgate',
    category: 'Oral Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['80g', 65],
      ['150g', 120],
    ],
  },
  {
    name: 'Closeup Everfresh Red Hot Gel Toothpaste',
    brand: 'Closeup',
    category: 'Oral Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['80g', 60],
      ['150g', 110],
    ],
  },
  {
    name: 'Britannia Good Day Cashew Cookies',
    brand: 'Britannia',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['60g', 10],
      ['100g', 25],
      ['200g', 45],
    ],
  },
  {
    name: 'Britannia Marie Gold Biscuits',
    brand: 'Britannia',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['120g', 15],
      ['250g', 35],
    ],
  },
  {
    name: 'Britannia Bourbon Chocolate Cream Biscuits',
    brand: 'Britannia',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['60g', 10],
      ['120g', 30],
    ],
  },
  {
    name: 'Sunfeast Dark Fantasy Choco Fills',
    brand: 'Sunfeast',
    category: 'Biscuits',
    gstRate: 18,
    shelfLifeDays: 180,
    variants: [
      ['75g', 35],
      ['300g', 140],
    ],
  },
  {
    name: 'Fortune Sunlite Refined Sunflower Oil',
    brand: 'Fortune',
    category: 'Edible Oils',
    gstRate: 5,
    shelfLifeDays: 270,
    variants: [
      ['500ml', 75],
      ['1L', 142],
      ['5L', 695],
    ],
  },
  {
    name: 'Freedom Refined Sunflower Oil',
    brand: 'Freedom',
    category: 'Edible Oils',
    gstRate: 5,
    shelfLifeDays: 270,
    variants: [
      ['1L', 140],
      ['5L', 685],
    ],
  },
  {
    name: 'Saffola Gold Blended Edible Oil',
    brand: 'Saffola',
    category: 'Edible Oils',
    gstRate: 5,
    shelfLifeDays: 270,
    variants: [
      ['1L', 195],
      ['5L', 945],
    ],
  },
  {
    name: 'India Gate Classic Basmati Rice',
    brand: 'India Gate',
    category: 'Rice & Grains',
    gstRate: 5,
    shelfLifeDays: 540,
    variants: [
      ['1kg', 210],
      ['5kg', 990],
    ],
  },
  {
    name: 'Daawat Rozana Gold Basmati Rice',
    brand: 'Daawat',
    category: 'Rice & Grains',
    gstRate: 5,
    shelfLifeDays: 540,
    variants: [
      ['1kg', 115],
      ['5kg', 540],
    ],
  },
  {
    name: 'Everest Garam Masala',
    brand: 'Everest',
    category: 'Spices',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['50g', 48],
      ['100g', 92],
    ],
  },
  {
    name: 'Everest Tikhalal Chilli Powder',
    brand: 'Everest',
    category: 'Spices',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['100g', 58],
      ['200g', 112],
      ['500g', 265],
    ],
  },
  {
    name: 'Everest Turmeric Powder (Haldi)',
    brand: 'Everest',
    category: 'Spices',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['100g', 42],
      ['200g', 80],
    ],
  },
  {
    name: 'MDH Chana Masala',
    brand: 'MDH',
    category: 'Spices',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['50g', 45],
      ['100g', 88],
    ],
  },
  {
    name: 'MDH Kitchen King Masala',
    brand: 'MDH',
    category: 'Spices',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['50g', 46],
      ['100g', 90],
    ],
  },
  {
    name: 'Brooke Bond Red Label Leaf Tea',
    brand: 'Brooke Bond',
    category: 'Tea & Coffee',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['100g', 55],
      ['250g', 140],
      ['500g', 275],
    ],
  },
  {
    name: 'Brooke Bond Taj Mahal Tea',
    brand: 'Brooke Bond',
    category: 'Tea & Coffee',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['250g', 195],
      ['500g', 380],
    ],
  },
  {
    name: 'Bru Instant Coffee',
    brand: 'Bru',
    category: 'Tea & Coffee',
    gstRate: 18,
    shelfLifeDays: 365,
    variants: [
      ['50g', 135],
      ['100g', 260],
      ['200g', 485],
    ],
  },
  {
    name: 'Nescafe Classic Instant Coffee',
    brand: 'Nestle',
    category: 'Tea & Coffee',
    gstRate: 18,
    shelfLifeDays: 365,
    variants: [
      ['24g', 95],
      ['45g', 175],
      ['90g', 340],
    ],
  },
  {
    name: 'Horlicks Classic Malt Health Drink',
    brand: 'Horlicks',
    category: 'Beverages',
    gstRate: 18,
    shelfLifeDays: 365,
    variants: [
      ['200g', 125],
      ['500g', 289],
      ['1kg', 515],
    ],
  },
  {
    name: 'Cadbury Bournvita Health Drink',
    brand: 'Cadbury',
    category: 'Beverages',
    gstRate: 18,
    shelfLifeDays: 365,
    variants: [
      ['200g', 115],
      ['500g', 245],
      ['1kg', 445],
    ],
  },
  {
    name: 'Boost Chocolate Energy Drink',
    brand: 'Boost',
    category: 'Beverages',
    gstRate: 18,
    shelfLifeDays: 365,
    variants: [
      ['200g', 120],
      ['500g', 285],
    ],
  },
  {
    name: 'Kissan Fresh Tomato Ketchup',
    brand: 'Kissan',
    category: 'Sauces & Spreads',
    gstRate: 12,
    shelfLifeDays: 270,
    variants: [
      ['200g', 48],
      ['500g', 99],
      ['950g', 145],
    ],
  },
  {
    name: 'Kissan Mixed Fruit Jam',
    brand: 'Kissan',
    category: 'Sauces & Spreads',
    gstRate: 12,
    shelfLifeDays: 365,
    variants: [
      ['200g', 85],
      ['500g', 175],
    ],
  },
  {
    name: 'Dabur Pure Honey',
    brand: 'Dabur',
    category: 'Sauces & Spreads',
    gstRate: 5,
    shelfLifeDays: 540,
    variants: [
      ['100g', 70],
      ['250g', 145],
      ['500g', 255],
    ],
  },
  {
    name: 'Haldiram Aloo Bhujia Namkeen',
    brand: 'Haldiram',
    category: 'Snacks',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['42g', 10],
      ['200g', 55],
      ['400g', 105],
    ],
  },
  {
    name: 'Haldiram Khatta Meetha Mixture',
    brand: 'Haldiram',
    category: 'Snacks',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['200g', 55],
      ['400g', 105],
    ],
  },
  {
    name: 'Kurkure Masala Munch',
    brand: 'Kurkure',
    category: 'Snacks',
    gstRate: 12,
    shelfLifeDays: 120,
    variants: [
      ['36g', 10],
      ['75g', 20],
      ['150g', 40],
    ],
  },
  {
    name: 'Lays India Magic Masala Potato Chips',
    brand: 'Lays',
    category: 'Snacks',
    gstRate: 12,
    shelfLifeDays: 120,
    variants: [
      ['24g', 10],
      ['48g', 20],
      ['90g', 40],
    ],
  },
  {
    name: 'Bingo Mad Angles Achaari Masti',
    brand: 'Bingo',
    category: 'Snacks',
    gstRate: 12,
    shelfLifeDays: 120,
    variants: [
      ['33g', 10],
      ['66g', 20],
    ],
  },
  {
    name: 'Cadbury Dairy Milk Chocolate',
    brand: 'Cadbury',
    category: 'Confectionery',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['13.2g', 10],
      ['24g', 20],
      ['50g', 45],
      ['110g', 95],
    ],
  },
  {
    name: 'Cadbury 5 Star Chocolate Bar',
    brand: 'Cadbury',
    category: 'Confectionery',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['20g', 10],
      ['40g', 20],
    ],
  },
  {
    name: 'Thums Up Soft Drink',
    brand: 'Coca-Cola',
    category: 'Cold Drinks',
    gstRate: 28,
    shelfLifeDays: 180,
    variants: [
      ['250ml', 20],
      ['750ml', 45],
      ['2.25L', 99],
    ],
  },
  {
    name: 'Sprite Lemon Lime Soft Drink',
    brand: 'Coca-Cola',
    category: 'Cold Drinks',
    gstRate: 28,
    shelfLifeDays: 180,
    variants: [
      ['250ml', 20],
      ['750ml', 45],
      ['2.25L', 99],
    ],
  },
  {
    name: 'Maaza Mango Drink',
    brand: 'Coca-Cola',
    category: 'Cold Drinks',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['150ml', 10],
      ['600ml', 42],
      ['1.2L', 75],
    ],
  },
  {
    name: 'Frooti Mango Drink',
    brand: 'Parle Agro',
    category: 'Cold Drinks',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['160ml', 10],
      ['600ml', 40],
      ['1.2L', 72],
    ],
  },
  {
    name: 'Real Fruit Power Mixed Fruit Juice',
    brand: 'Dabur',
    category: 'Cold Drinks',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['180ml', 20],
      ['1L', 130],
    ],
  },
  {
    name: 'Harpic Power Plus Toilet Cleaner',
    brand: 'Harpic',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['200ml', 46],
      ['500ml', 105],
      ['1L', 199],
    ],
  },
  {
    name: 'Lizol Disinfectant Surface Cleaner Citrus',
    brand: 'Lizol',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['500ml', 115],
      ['1L', 215],
      ['2L', 399],
    ],
  },
  {
    name: 'Rin Detergent Bar',
    brand: 'Rin',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['125g', 10],
      ['250g', 25],
    ],
  },
  {
    name: 'Tide Plus Double Power Detergent Powder',
    brand: 'Tide',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['500g', 68],
      ['1kg', 130],
    ],
  },
  {
    name: 'Ariel Complete Detergent Powder',
    brand: 'Ariel',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['500g', 95],
      ['1kg', 180],
    ],
  },
  {
    name: 'Parachute 100% Pure Coconut Oil',
    brand: 'Parachute',
    category: 'Hair Care',
    gstRate: 18,
    shelfLifeDays: 540,
    variants: [
      ['100ml', 45],
      ['250ml', 108],
      ['600ml', 240],
    ],
  },
  {
    name: 'Clinic Plus Strong & Long Health Shampoo',
    brand: 'Clinic Plus',
    category: 'Hair Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['175ml', 120],
      ['340ml', 215],
      ['650ml', 390],
    ],
  },
  {
    name: 'Head & Shoulders Cool Menthol Shampoo',
    brand: 'Head & Shoulders',
    category: 'Hair Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['180ml', 195],
      ['340ml', 350],
    ],
  },
  {
    name: 'Good Knight Gold Flash Liquid Vapouriser Refill',
    brand: 'Good Knight',
    category: 'Home Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['45ml', 82],
      ['2x45ml', 155],
    ],
  },
  {
    name: 'Patanjali Dant Kanti Natural Toothpaste',
    brand: 'Patanjali',
    category: 'Oral Care',
    gstRate: 18,
    shelfLifeDays: 540,
    variants: [
      ['100g', 60],
      ['200g', 110],
    ],
  },
  {
    name: 'MTR Rava Idli Instant Mix',
    brand: 'MTR',
    category: 'Ready to Cook',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['200g', 75],
      ['500g', 165],
    ],
  },
  {
    name: 'MTR Sambar Powder',
    brand: 'MTR',
    category: 'Spices',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['100g', 68],
      ['200g', 130],
    ],
  },
  {
    name: 'Saffola Masala Oats Classic Masala',
    brand: 'Saffola',
    category: 'Breakfast',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['38g', 20],
      ['500g', 199],
    ],
  },
  {
    name: 'Kelloggs Corn Flakes Original',
    brand: 'Kelloggs',
    category: 'Breakfast',
    gstRate: 18,
    shelfLifeDays: 270,
    variants: [
      ['250g', 115],
      ['475g', 205],
    ],
  },
  {
    name: 'Quaker Rolled Oats',
    brand: 'Quaker',
    category: 'Breakfast',
    gstRate: 5,
    shelfLifeDays: 365,
    variants: [
      ['400g', 85],
      ['1kg', 195],
    ],
  },
  {
    name: 'Dabur Red Ayurvedic Toothpaste',
    brand: 'Dabur',
    category: 'Oral Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['100g', 68],
      ['200g', 128],
    ],
  },
  {
    name: 'Nivea Soft Light Moisturising Cream',
    brand: 'Nivea',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['50ml', 115],
      ['100ml', 210],
    ],
  },
  {
    name: 'Vaseline Intensive Care Deep Moisture Lotion',
    brand: 'Vaseline',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['100ml', 120],
      ['400ml', 360],
    ],
  },
  {
    name: 'Pears Pure & Gentle Bathing Bar',
    brand: 'Pears',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['75g', 45],
      ['125g', 72],
    ],
  },
  {
    name: 'Lux Rose & Vitamin E Soap',
    brand: 'Lux',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['100g', 36],
      ['3x100g', 105],
    ],
  },
  {
    name: 'Cinthol Original Deodorant Soap',
    brand: 'Cinthol',
    category: 'Personal Care',
    gstRate: 18,
    shelfLifeDays: 730,
    variants: [
      ['100g', 42],
      ['4x100g', 160],
    ],
  },
  {
    name: 'Whisper Ultra Clean Sanitary Pads XL',
    brand: 'Whisper',
    category: 'Personal Care',
    gstRate: 0,
    shelfLifeDays: 1095,
    variants: [
      ['7 Pads', 99],
      ['15 Pads', 195],
    ],
  },
  {
    name: 'Paper Boat Aamras Mango Drink',
    brand: 'Paper Boat',
    category: 'Cold Drinks',
    gstRate: 12,
    shelfLifeDays: 180,
    variants: [
      ['150ml', 20],
      ['250ml', 35],
    ],
  },
];

function computeEan13(prefix12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(prefix12[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return `${prefix12}${check}`;
}

function buildIndianKiranaProducts(): SeedProduct[] {
  const items: SeedProduct[] = [];
  let seq = 100001;

  for (const sku of INDIAN_KIRANA_CATALOG) {
    for (const [packSize, mrp] of sku.variants) {
      const ean = computeEan13(`890105${String(seq).padStart(6, '0')}`);
      seq += 1;
      items.push({
        ean,
        name: `${sku.name} ${packSize}`,
        brand: sku.brand,
        packSize,
        category: sku.category,
        mrp,
        gstRate: sku.gstRate,
        shelfLifeDays: sku.shelfLifeDays,
      });
    }
  }
  return items;
}

const SYNTHETIC_BRANDS = [
  'Annapurna',
  'Kaveri',
  'Deccan Fresh',
  'Bharath',
  'Swastik',
  'Sahyadri',
  'Narmada',
  'Godavari',
  'Surya',
  'Vindhya',
  'Malabar',
  'Nilgiri',
  'Ganga',
  'Shakti',
  'Prabhat',
  'Kisan Gold',
  'Arogya',
  'Saffron Valley',
  'Green Harvest',
  'Royal Spice',
];

const SYNTHETIC_ITEMS = [
  { label: 'Chana Dal', category: 'Pulses', gstRate: 5 as const, shelf: 365 },
  { label: 'Moong Dal', category: 'Pulses', gstRate: 5 as const, shelf: 365 },
  { label: 'Urad Dal', category: 'Pulses', gstRate: 5 as const, shelf: 365 },
  { label: 'Poha Flattened Rice', category: 'Rice & Grains', gstRate: 5 as const, shelf: 240 },
  { label: 'Sooji Rava', category: 'Flours', gstRate: 5 as const, shelf: 180 },
  { label: 'Besan Chickpea Flour', category: 'Flours', gstRate: 5 as const, shelf: 180 },
  { label: 'Mustard Oil', category: 'Edible Oils', gstRate: 5 as const, shelf: 270 },
  { label: 'Groundnut Oil', category: 'Edible Oils', gstRate: 5 as const, shelf: 270 },
  { label: 'Coriander Powder', category: 'Spices', gstRate: 5 as const, shelf: 365 },
  { label: 'Cumin Seeds Jeera', category: 'Spices', gstRate: 5 as const, shelf: 365 },
  { label: 'Black Pepper Whole', category: 'Spices', gstRate: 5 as const, shelf: 365 },
  { label: 'Roasted Peanuts', category: 'Snacks', gstRate: 12 as const, shelf: 150 },
  { label: 'Salted Banana Chips', category: 'Snacks', gstRate: 12 as const, shelf: 120 },
  { label: 'Butter Rusk Toast', category: 'Biscuits', gstRate: 18 as const, shelf: 150 },
  { label: 'Cream Wafer Biscuits', category: 'Biscuits', gstRate: 18 as const, shelf: 180 },
  { label: 'Mango Pickle', category: 'Sauces & Spreads', gstRate: 12 as const, shelf: 365 },
  { label: 'Lemon Squash', category: 'Cold Drinks', gstRate: 12 as const, shelf: 240 },
  { label: 'Herbal Bath Soap', category: 'Personal Care', gstRate: 18 as const, shelf: 730 },
  { label: 'Floor Cleaner Pine', category: 'Home Care', gstRate: 18 as const, shelf: 730 },
  { label: 'Laundry Detergent Cake', category: 'Home Care', gstRate: 18 as const, shelf: 730 },
];

const PACK_SIZES = ['50g', '100g', '200g', '250g', '500g', '1kg', '2kg', '5kg', '250ml', '1L'];

async function* readOpenFoodFactsFile(filePath: string): AsyncGenerator<SeedProduct> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const isJsonl = filePath.toLowerCase().endsWith('.jsonl') || filePath.endsWith('.json');
  let isHeader = true;

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isJsonl) {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const ean = String(rec.code ?? rec.ean ?? '').replace(/[^0-9]/g, '');
        const name = String(rec.product_name ?? rec.name ?? '').trim();
        if (ean.length < 8 || ean.length > 14 || name.length < 2) continue;

        yield {
          ean,
          name: name.slice(0, 200),
          brand: String(rec.brands ?? rec.brand ?? 'Generic').slice(0, 120) || 'Generic',
          packSize: String(rec.quantity ?? rec.packSize ?? '1 unit').slice(0, 64) || '1 unit',
          category: String(rec.categories ?? rec.category ?? 'Grocery').slice(0, 80) || 'Grocery',
          mrp: Number(rec.mrp) > 0 ? Number(rec.mrp) : 50,
          gstRate: 5,
          shelfLifeDays: 180,
        };
      } catch {
        continue;
      }
    } else {
      if (isHeader) {
        isHeader = false;
        continue;
      }
      const cols = line.split(',');
      if (cols.length < 2) continue;
      const ean = cols[0].replace(/[^0-9]/g, '');
      const name = (cols[1] || '').trim();
      if (ean.length < 8 || ean.length > 14 || name.length < 2) continue;

      yield {
        ean,
        name: name.slice(0, 200),
        brand: (cols[2] || 'Generic').trim().slice(0, 120) || 'Generic',
        packSize: (cols[3] || '1 unit').trim().slice(0, 64) || '1 unit',
        category: (cols[4] || 'Grocery').trim().slice(0, 80) || 'Grocery',
        mrp: Number(cols[5]) > 0 ? Number(cols[5]) : 50,
        gstRate: 5,
        shelfLifeDays: 180,
      };
    }
  }
}

async function flushChunk(client: Client, chunk: SeedProduct[]): Promise<number> {
  if (chunk.length === 0) return 0;

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < chunk.length; i++) {
    const p = chunk[i];
    const base = i * 8;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
    values.push(
      p.ean,
      p.name,
      p.brand,
      p.packSize,
      p.category,
      p.mrp.toFixed(2),
      p.gstRate.toFixed(2),
      p.shelfLifeDays,
    );
  }

  const res = await client.query(
    `
    INSERT INTO products (ean, name, brand, pack_size, category, mrp, gst_rate, shelf_life_days)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (ean) DO NOTHING
    `,
    values,
  );
  return res.rowCount ?? 0;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let targetCount = 50000;
  let filePath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target-count' && args[i + 1]) {
      targetCount = Number.parseInt(args[i + 1], 10);
      i += 1;
    } else if (args[i] === '--file' && args[i + 1]) {
      filePath = args[i + 1];
      i += 1;
    }
  }
  return { targetCount: Number.isNaN(targetCount) ? 50000 : targetCount, filePath };
}

async function main() {
  const { targetCount, filePath } = parseArgs();
  const startedAt = Date.now();

  const client = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'kirana_admin',
    password: process.env.DB_PASSWORD || 'secretpassword',
    database: process.env.DB_NAME || 'catalog_db',
  });

  await client.connect();

  try {
    let inserted = 0;
    let buffer: SeedProduct[] = [];
    const CHUNK_SIZE = 1000;

    // 1. Seed authentic Indian kirana SKUs (~200 SKUs)
    const indianSkus = buildIndianKiranaProducts();
    for (const sku of indianSkus) {
      buffer.push(sku);
      if (buffer.length >= CHUNK_SIZE) {
        inserted += await flushChunk(client, buffer);
        buffer = [];
      }
    }

    // 2. Optionally ingest Open Food Facts CSV/JSONL subset
    if (filePath) {
      for await (const offProduct of readOpenFoodFactsFile(filePath)) {
        buffer.push(offProduct);
        if (buffer.length >= CHUNK_SIZE) {
          inserted += await flushChunk(client, buffer);
          buffer = [];
        }
      }
    }

    if (buffer.length > 0) {
      inserted += await flushChunk(client, buffer);
      buffer = [];
    }

    // 3. Top up with deterministic Open-Food-Facts-style retail SKUs to reach targetCount
    const countRes = await client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM products',
    );
    const existingCount = Number.parseInt(countRes.rows[0].count, 10);
    const remaining = Math.max(0, targetCount - existingCount);

    for (let idx = 0; idx < remaining; idx++) {
      const brand = SYNTHETIC_BRANDS[idx % SYNTHETIC_BRANDS.length];
      const item =
        SYNTHETIC_ITEMS[Math.floor(idx / SYNTHETIC_BRANDS.length) % SYNTHETIC_ITEMS.length];
      const packSize = PACK_SIZES[Math.floor(idx / 400) % PACK_SIZES.length];
      const variantCode = Math.floor(idx / 4000) + 1;
      const ean = computeEan13(`8909${String(idx + 1).padStart(8, '0')}`);

      buffer.push({
        ean,
        name: `${brand} ${item.label} Grade-${variantCode} ${packSize}`,
        brand,
        packSize,
        category: item.category,
        mrp: 15 + ((idx * 17) % 450),
        gstRate: item.gstRate,
        shelfLifeDays: item.shelf,
      });

      if (buffer.length >= CHUNK_SIZE) {
        inserted += await flushChunk(client, buffer);
        buffer = [];
      }
    }

    if (buffer.length > 0) {
      inserted += await flushChunk(client, buffer);
      buffer = [];
    }

    await client.query('ANALYZE products;');
    const finalCountRes = await client.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM products',
    );

    logger.info(
      {
        correlationId: 'seed-catalog',
        indianSkusSeeded: indianSkus.length,
        newlyInserted: inserted,
        totalProducts: Number.parseInt(finalCountRes.rows[0].count, 10),
        elapsedMs: Date.now() - startedAt,
      },
      'Catalog seed complete',
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  logger.error(
    { correlationId: 'seed-catalog', err: (err as Error).message },
    'Catalog seed failed',
  );
  process.exit(1);
});
