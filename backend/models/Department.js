import mongoose from "mongoose";

const DepartmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Department name is required"],
      trim: true
    },
    description: {
      type: String,
      default: "",
      trim: true
    },
    isTestData: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  { timestamps: true }
);

// Case-insensitive uniqueness index on name
DepartmentSchema.index({ name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

export const Department = mongoose.model("Department", DepartmentSchema);
