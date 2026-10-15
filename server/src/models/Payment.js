const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class Payment extends Model {}

Payment.init(
  {
    paymentId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'payment_id' },
    appointmentId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'appointment_id' },
    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    method: { type: DataTypes.ENUM('cash', 'card', 'insurance', 'upi', 'bank_transfer'), allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'paid', 'refunded', 'failed'), allowNull: false, defaultValue: 'pending' },
    transactionRef: { type: DataTypes.STRING(120), allowNull: true, field: 'transaction_ref' },
    paidAt: { type: DataTypes.DATE, allowNull: true, field: 'paid_at' },
  },
  { sequelize, modelName: 'Payment', tableName: 'payments', updatedAt: false }
);

module.exports = Payment;
