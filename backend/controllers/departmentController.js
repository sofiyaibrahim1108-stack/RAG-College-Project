import { Department } from "../models/Department.js";
import { Document } from "../models/Document.js";
import { DocumentChunk } from "../models/DocumentChunk.js";
import { ImageModel } from "../models/Image.js";
import { invalidateDepartmentProfilesCache } from "../services/router.js";

/**
 * Get all departments with document count
 */
export async function getDepartments(req, res) {
  try {
    const departments = await Department.find().sort({ name: 1 }).lean();

    // Compute document count for each department
    const counts = await Document.aggregate([
      {
        $group: {
          _id: "$departmentId",
          deptName: { $first: "$department" },
          count: { $sum: 1 }
        }
      }
    ]);

    const countMap = {};
    for (const c of counts) {
      if (c._id) countMap[c._id.toString()] = c.count;
      if (c.deptName) countMap[c.deptName] = (countMap[c.deptName] || 0) + c.count;
    }

    const result = departments.map((dept) => ({
      ...dept,
      documentCount: countMap[dept._id.toString()] || countMap[dept.name] || 0
    }));

    res.json({ success: true, count: result.length, departments: result });
  } catch (error) {
    console.error(`[getDepartments Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Get single department by ID
 */
export async function getDepartmentById(req, res) {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ error: "Department not found" });
    }
    const documentCount = await Document.countDocuments({
      $or: [{ departmentId: department._id }, { department: department.name }]
    });
    res.json({ success: true, department: { ...department.toObject(), documentCount } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * Create a new department
 */
export async function createDepartment(req, res) {
  try {
    const { name, description, isTestData } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Department name is required" });
    }

    const trimmedName = name.trim();
    const existing = await Department.findOne({
      name: { $regex: new RegExp(`^${trimmedName}$`, "i") }
    });

    if (existing) {
      return res.status(400).json({ error: `Department "${trimmedName}" already exists` });
    }

    const department = await Department.create({
      name: trimmedName,
      description: description ? description.trim() : "",
      isTestData: Boolean(isTestData)
    });
    try { invalidateDepartmentProfilesCache(); } catch (e) {}

    res.status(201).json({
      success: true,
      message: "Department created successfully",
      department
    });
  } catch (error) {
    console.error(`[createDepartment Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Update an existing department
 */
export async function updateDepartment(req, res) {
  try {
    const { name, description } = req.body;
    const department = await Department.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ error: "Department not found" });
    }

    const oldName = department.name;
    if (name && name.trim()) {
      const trimmedName = name.trim();
      if (trimmedName.toLowerCase() !== oldName.toLowerCase()) {
        const existing = await Department.findOne({
          name: { $regex: new RegExp(`^${trimmedName}$`, "i") },
          _id: { $ne: department._id }
        });
        if (existing) {
          return res.status(400).json({ error: `Department "${trimmedName}" already exists` });
        }
      }
      department.name = trimmedName;
    }

    if (description !== undefined) {
      department.description = description.trim();
    }

    await department.save();

    // Keep documents, chunks, and images department name synchronized if name changed
    if (oldName !== department.name) {
      await Document.updateMany(
        { $or: [{ departmentId: department._id }, { department: oldName }] },
        { $set: { department: department.name, departmentId: department._id } }
      );
      await DocumentChunk.updateMany(
        { $or: [{ departmentId: department._id }, { department: oldName }] },
        { $set: { department: department.name, departmentId: department._id } }
      );
      await ImageModel.updateMany(
        { $or: [{ departmentId: department._id }, { department: oldName }] },
        { $set: { department: department.name, departmentId: department._id } }
      );
    }
    try { invalidateDepartmentProfilesCache(); } catch (e) {}

    res.json({
      success: true,
      message: "Department updated successfully",
      department
    });
  } catch (error) {
    console.error(`[updateDepartment Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}

/**
 * Delete a department with safety checks
 * - If department contains documents and force != true, block deletion and report count
 * - If force == true and only test documents exist (or explicit confirm), allow deletion
 */
export async function deleteDepartment(req, res) {
  try {
    const { id } = req.params;
    const { force, deleteTestDocumentsOnly } = req.query;

    const department = await Department.findById(id);
    if (!department) {
      return res.status(404).json({ error: "Department not found" });
    }

    const attachedDocs = await Document.find({
      $or: [{ departmentId: department._id }, { department: department.name }]
    });

    const docCount = attachedDocs.length;
    const testDocCount = attachedDocs.filter((d) => d.isTestData).length;
    const realDocCount = docCount - testDocCount;

    if (docCount > 0 && force !== "true") {
      return res.status(400).json({
        error: `Cannot delete department "${department.name}". It contains ${docCount} document(s).`,
        documentCount: docCount,
        testDocumentCount: testDocCount,
        realDocumentCount: realDocCount,
        requiresConfirmation: true
      });
    }

    // If real docs exist and caller didn't explicitly accept removing them, protect real docs
    if (realDocCount > 0 && deleteTestDocumentsOnly === "true") {
      return res.status(400).json({
        error: `Department contains ${realDocCount} real document(s). Please move or delete real documents first before deleting this department.`
      });
    }

    // If force deletion requested, delete attached documents (or test documents)
    if (docCount > 0 && force === "true") {
      const docIdsToDelete = attachedDocs
        .filter((d) => (deleteTestDocumentsOnly === "true" ? d.isTestData : true))
        .map((d) => d._id);

      if (docIdsToDelete.length > 0) {
        await DocumentChunk.deleteMany({ documentId: { $in: docIdsToDelete } });
        await ImageModel.deleteMany({ documentId: { $in: docIdsToDelete } });
        await Document.deleteMany({ _id: { $in: docIdsToDelete } });
      }
    }

    await Department.findByIdAndDelete(department._id);
    try { invalidateDepartmentProfilesCache(); } catch (e) {}

    res.json({
      success: true,
      message: `Department "${department.name}" deleted successfully`
    });
  } catch (error) {
    console.error(`[deleteDepartment Error] ${error.message}`);
    res.status(500).json({ error: error.message });
  }
}
