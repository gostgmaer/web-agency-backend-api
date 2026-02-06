import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import Admin from '../models/Admin.js';
import { connectDatabase } from '../config/database.js';

dotenv.config();

const createAdmin = async () => {
  try {
    await connectDatabase();

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@webagency.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({ email: adminEmail });
    if (existingAdmin) {
      console.log('Admin already exists:', adminEmail);
      process.exit(0);
    }

    // Create new admin
    const admin = new Admin({
      email: adminEmail,
      password: adminPassword,
      name: 'System Admin',
      role: 'super-admin'
    });

    await admin.save();

    console.log('Admin created successfully:');
    console.log('Email:', adminEmail);
    console.log('Password:', adminPassword);
    console.log('Role:', admin.role);

    process.exit(0);
  } catch (error) {
    console.error('Error creating admin:', error);
    process.exit(1);
  }
};

createAdmin();