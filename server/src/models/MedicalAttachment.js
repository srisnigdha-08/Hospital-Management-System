const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/db');

class MedicalAttachment extends Model {}

MedicalAttachment.init(
  {
    attachmentId: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, field: 'attachment_id' },
    recordId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'record_id' },
    fileName: { type: DataTypes.STRING(255), allowNull: false, field: 'file_name' },
    filePath: { type: DataTypes.STRING(500), allowNull: false, field: 'file_path' },
    fileType: { type: DataTypes.STRING(50), allowNull: true, field: 'file_type' },
    fileSizeBytes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'file_size_bytes' },
    uploadedBy: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'uploaded_by' },
    uploadedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'uploaded_at' },
  },
  { sequelize, modelName: 'MedicalAttachment', tableName: 'medical_attachments', timestamps: false }
);

module.exports = MedicalAttachment;
